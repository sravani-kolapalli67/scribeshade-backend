import { Prisma } from "@prisma/client";
import crypto from "node:crypto";
import Razorpay from "razorpay";
import { prisma } from "../../shared/lib/prisma";
import { env } from "../../config/env";
import { AppError } from "../../shared/middleware/error.middleware";
import type {
  BracketSnapshot,
  HoldResult,
  DeductionResult,
  CreditPackPlan,
  PurchaseOrderResult,
} from "./credits.types";

// ─── Internal Decimal helper ──────────────────────────────────────────────────

function d(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

type SupportedCurrency = "INR" | "USD" | "GBP";

const MINOR_UNIT_MULTIPLIER: Record<SupportedCurrency, number> = {
  INR: 100,
  USD: 100,
  GBP: 100,
};

function normalizeCurrency(input?: string): SupportedCurrency {
  const value = (input ?? "INR").toUpperCase();
  if (value === "USD" || value === "GBP") return value;
  return "INR";
}

function toMinorUnits(
  amountMajor: string,
  currency: SupportedCurrency,
): number {
  const multiplier = MINOR_UNIT_MULTIPLIER[currency];
  return Math.round(Number(amountMajor) * multiplier);
}

/** Map a CreditPack DB row into the DTO the controllers/frontend expect. */
function packToDTO(
  pack: {
    code: string;
    name: string;
    credits: Prisma.Decimal;
    feature: string;
    priceInr: Prisma.Decimal;
    priceUsd: Prisma.Decimal;
    priceGbp: Prisma.Decimal;
    valuePct: number;
    isPopular: boolean;
  },
  currency: SupportedCurrency,
): CreditPackPlan {
  const amountMajor =
    currency === "USD"
      ? pack.priceUsd.toString()
      : currency === "GBP"
        ? pack.priceGbp.toString()
        : pack.priceInr.toString();

  return {
    code: pack.code,
    name: pack.name,
    credits: pack.credits.toString(),
    currency,
    amountMajor,
    amountMinor: toMinorUnits(amountMajor, currency),
    feature: pack.feature as "INTERVIEW_SESSION",
    valuePct: pack.valuePct,
    isPopular: pack.isPopular,
  };
}

function getRazorpayKeys(): { keyId: string; keySecret: string } {
  const isProd = env.NODE_ENV === "production";
  const keyId     = isProd ? env.RAZORPAY_KEY_ID_PROD     : env.RAZORPAY_KEY_ID;
  const keySecret = isProd ? env.RAZORPAY_KEY_SECRET_PROD : env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new AppError(500, "Razorpay is not configured");
  }
  return { keyId, keySecret };
}

function getRazorpayClient(): Razorpay {
  const { keyId, keySecret } = getRazorpayKeys();
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

function assertValidRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string,
): void {
  const { keySecret } = getRazorpayKeys();

  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  if (expected !== signature) {
    throw new AppError(400, "INVALID_PAYMENT_SIGNATURE");
  }
}

export async function getInterviewCreditPlans(
  currencyInput?: string,
): Promise<CreditPackPlan[]> {
  const currency = normalizeCurrency(currencyInput);
  const packs = await prisma.creditPack.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  return packs.map((pack) => packToDTO(pack, currency));
}

export async function createPurchaseOrder(
  userId: string,
  packCode: string,
  currencyInput?: string,
): Promise<PurchaseOrderResult> {
  const currency = normalizeCurrency(currencyInput);
  const pack = await prisma.creditPack.findUnique({
    where: { code: packCode, isActive: true },
  });
  if (!pack) {
    throw new AppError(400, "Invalid packCode");
  }

  const plan = packToDTO(pack, currency);
  const razorpay = getRazorpayClient();

  const order = await razorpay.orders.create({
    amount: plan.amountMinor,
    currency: plan.currency,
    receipt: `credits_${userId.slice(0, 8)}_${Date.now()}`,
    notes: {
      userId,
      packCode: plan.code,
      feature: plan.feature,
    },
  });

  await prisma.creditPurchase.upsert({
    where: { paymentProviderEventId: order.id },
    update: {},
    create: {
      userId,
      packName: plan.name,
      creditsPurchased: d(plan.credits),
      creditsRemaining: d(plan.credits),
      paymentProviderEventId: order.id,
      amountPaid: d(plan.amountMajor),
      currency: plan.currency,
      status: "PENDING",
    },
  });

  return {
    orderId: order.id,
    keyId: getRazorpayKeys().keyId,
    amountMinor: plan.amountMinor,
    amountMajor: plan.amountMajor,
    currency: plan.currency,
    plan,
  };
}

export async function verifyAndConfirmPurchase(
  userId: string,
  orderId: string,
  paymentId: string,
  signature: string,
) {
  assertValidRazorpaySignature(orderId, paymentId, signature);

  const existingPurchase = await prisma.creditPurchase.findUnique({
    where: { paymentProviderEventId: orderId },
  });

  if (!existingPurchase) {
    throw new AppError(404, "Purchase order not found");
  }

  if (existingPurchase.userId !== userId) {
    throw new AppError(403, "Purchase does not belong to this user");
  }

  if (existingPurchase.status === "CONFIRMED") {
    return {
      alreadyConfirmed: true,
      purchaseId: existingPurchase.id,
      creditsAdded: existingPurchase.creditsPurchased.toString(),
      currency: existingPurchase.currency,
      packName: existingPurchase.packName,
    };
  }

  await confirmPurchase(
    userId,
    existingPurchase.packName,
    existingPurchase.creditsPurchased.toString(),
    orderId,
    existingPurchase.amountPaid.toString(),
    existingPurchase.currency,
  );

  return {
    alreadyConfirmed: false,
    purchaseId: existingPurchase.id,
    creditsAdded: existingPurchase.creditsPurchased.toString(),
    currency: existingPurchase.currency,
    packName: existingPurchase.packName,
  };
}

export async function markPurchaseFailed(
  userId: string,
  orderId: string,
  failureReason?: string,
): Promise<{ purchaseId: string }> {
  const purchase = await prisma.creditPurchase.findUnique({
    where: { paymentProviderEventId: orderId },
  });

  if (!purchase) {
    throw new AppError(404, "Purchase order not found");
  }

  if (purchase.userId !== userId) {
    throw new AppError(403, "Purchase does not belong to this user");
  }

  // Only PENDING orders can be marked as failed
  if (purchase.status !== "PENDING") {
    return { purchaseId: purchase.id };
  }

  await prisma.creditPurchase.update({
    where: { id: purchase.id },
    data: {
      status: "FAILED",
      ...(failureReason ? { packName: `${purchase.packName} [${failureReason}]` } : {}),
    },
  });

  return { purchaseId: purchase.id };
}

// ─── Balance ──────────────────────────────────────────────────────────────────

export async function getOrCreateBalance(userId: string) {
  return prisma.userCreditBalance.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      purchasedCredits: d(0),
      earnedCredits: d(0),
      heldCredits: d(0),
      totalAvailable: d(0),
    },
  });
}

export async function getCreditBalance(userId: string) {
  return getOrCreateBalance(userId);
}

// ─── Brackets ─────────────────────────────────────────────────────────────────

export async function getActiveBrackets() {
  return prisma.creditConfig.findMany({
    where: { isActive: true },
    orderBy: { bracketMinutes: "asc" },
  });
}

// ─── maxAllowedMinutes computation ────────────────────────────────────────────

/**
 * Given available credits, computes how many minutes the user can afford.
 * Throws AppError(402) if the user cannot afford even 1 paid minute.
 * Does NOT move any credits — purely a read + compute.
 */
export async function computeMaxAllowedMinutes(
  availableCredits: Prisma.Decimal,
): Promise<{
  maxMinutes: number;
  snapshot: BracketSnapshot;
}> {
  const brackets = await getActiveBrackets();

  if (!brackets.length) {
    throw new AppError(500, "No active credit brackets configured");
  }

  const chosen = brackets[0];
  const ratePerMin = 0.5;
  const freeMins = chosen.freeZoneMinutes;

  // With full-duration billing (past the free zone we charge from minute 0),
  // the maximum session length a user can afford is:
  //   availableCredits / ratePerMin  total minutes
  // They always get the free zone — if they can't afford a single paid minute
  // beyond the free zone they still get `freeMins` for free.
  const affordableTotalMinutes = Math.floor(availableCredits.toNumber() / ratePerMin);

  // If they can't even afford 1 full minute at rate, allow the free zone only.
  const maxMinutes = Math.max(freeMins, affordableTotalMinutes);

  const snapshot: BracketSnapshot = {
    id: chosen.id,
    bracketMinutes: maxMinutes,
    creditsFull: chosen.creditsFull.toString(),
    creditsHalf: chosen.creditsHalf.toString(),
    freeZoneMinutes: chosen.freeZoneMinutes,
    graceZoneMinutes: chosen.graceZoneMinutes,
  };

  return { maxMinutes, snapshot };
}

// ─── Deduction ────────────────────────────────────────────────────────────────

/**
 * Core bracket deduction. Runs inside a Prisma $transaction.
 *
 * Decision tree:
 *   activeDurationMinutes <= freeZone → FREE_ZONE  (deduct 0)
 *   else                              → deduct for the FULL duration (0 → end)
 *                                       at 0.5 credits/min
 */
export async function deductCredits(
  userId: string,
  sessionId: string,
  activeDurationMinutes: number,
  snapshot: BracketSnapshot,
  isExhausted: boolean,
  tx: Prisma.TransactionClient,
): Promise<DeductionResult> {
  const {
    freeZoneMinutes,
  } = snapshot;

  // ── Decision tree ──────────────────────────────────────────────────────────
  let deductAmount: Prisma.Decimal;
  let reason: string;

  if (activeDurationMinutes <= freeZoneMinutes) {
    deductAmount = d(0);
    reason = "FREE_ZONE";
  } else {
    // Beyond the free zone → charge for the FULL session duration from minute 0.
    // Example: 5m 30s → ceil to 6 minutes → 6 × 0.5 = 3 credits
    deductAmount = d(activeDurationMinutes).mul(0.5);
    reason = isExhausted ? "EXHAUSTED" : "PER_MINUTE_DEDUCTION";
  }

  // ── Fetch balance ──────────────────────────────────────────────────────────
  const balance = await tx.userCreditBalance.findUnique({ where: { userId } });
  if (!balance)
    throw new AppError(500, "Credit balance not found for deduction");

  const purchasedDec = d(balance.purchasedCredits.toString());
  const earnedDec = d(balance.earnedCredits.toString());
  const balanceBefore = purchasedDec.add(earnedDec);

  console.log(
    `[CREDIT_DEDUCTION] Session=${sessionId} User=${userId} Duration=${activeDurationMinutes}m. ` +
      `Deduct=${deductAmount} Reason=${reason}. ` +
      `Balance (P/E): ${purchasedDec}/${earnedDec}`,
  );

  // ── Negative balance guard ─────────────────────────────────────────────────
  if (balanceBefore.lt(deductAmount)) {
    console.error(
      `[DEDUCTION_ANOMALY] userId=${userId} sessionId=${sessionId} ` +
        `before=${balanceBefore} deduct=${deductAmount}`,
    );
    // Clamp — never write a negative balance
    deductAmount = balanceBefore.gt(0) ? balanceBefore : d(0);
  }

  const balanceAfter = balanceBefore.sub(deductAmount);

  // ── Apply deduction across pools ──────────────────────────────────────────
  let remainingDeduct = deductAmount;
  let nextPurchased = purchasedDec;
  let nextEarned = earnedDec;

  // Deduct from purchased pool first
  if (nextPurchased.gte(remainingDeduct)) {
    nextPurchased = nextPurchased.sub(remainingDeduct);
    remainingDeduct = d(0);
  } else {
    remainingDeduct = remainingDeduct.sub(nextPurchased);
    nextPurchased = d(0);
  }

  // Deduct remainder from earned pool
  if (remainingDeduct.gt(0)) {
    nextEarned = nextEarned.sub(remainingDeduct);
    if (nextEarned.lt(0)) nextEarned = d(0);
  }

  // ── No hold to release — totalAvailable is derived directly ───────────────
  // Formula: totalAvailable = (purchased + earned) - heldCredits (unchanged)
  const currentHeld = d(balance.heldCredits.toString());
  const nextTotalAvailable = nextPurchased.add(nextEarned).sub(currentHeld);

  await tx.userCreditBalance.update({
    where: { userId },
    data: {
      purchasedCredits: nextPurchased,
      earnedCredits: nextEarned,
      // heldCredits unchanged — no hold system
      totalAvailable: nextTotalAvailable.lt(0) ? d(0) : nextTotalAvailable,
    },
  });

  // ── Immutable ledger entry ─────────────────────────────────────────────────
  await tx.creditLedger.create({
    data: {
      userId,
      sessionId,
      type: "DEBIT",
      amount: deductAmount,
      balanceBefore,
      balanceAfter,
      reason,
    },
  });

  return {
    creditsDeducted: deductAmount.toString(),
    reason,
    newBalance: balanceAfter.toString(),
  };
}

// ─── Purchase confirmation (webhook) ──────────────────────────────────────────

/**
 * Confirms a pending purchase and credits the user's balance.
 * Idempotent — the paymentProviderEventId unique constraint prevents double-credit.
 */
export async function confirmPurchase(
  userId: string,
  packName: string,
  creditsPurchased: string,
  paymentProviderEventId: string,
  amountPaid: string,
  currency: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.creditPurchase.findUnique({
      where: { paymentProviderEventId },
    });

    // Idempotent guard: already confirmed means we already credited once.
    if (existing?.status === "CONFIRMED") {
      return;
    }

    if (existing) {
      await tx.creditPurchase.update({
        where: { id: existing.id },
        data: {
          status: "CONFIRMED",
          confirmedAt: new Date(),
        },
      });
    } else {
      await tx.creditPurchase.create({
        data: {
          userId,
          packName,
          creditsPurchased: d(creditsPurchased),
          creditsRemaining: d(creditsPurchased),
          paymentProviderEventId,
          amountPaid: d(amountPaid),
          currency,
          status: "CONFIRMED",
          confirmedAt: new Date(),
        },
      });
    }

    // Add to balance
    const balance = await tx.userCreditBalance.findUnique({
      where: { userId },
    });
    const currentPurchased = balance
      ? d(balance.purchasedCredits.toString())
      : d(0);
    const currentAvailable = balance
      ? d(balance.totalAvailable.toString())
      : d(0);
    const credits = d(creditsPurchased);

    await tx.userCreditBalance.upsert({
      where: { userId },
      update: {
        purchasedCredits: currentPurchased.add(credits),
        totalAvailable: currentAvailable.add(credits),
      },
      create: {
        userId,
        purchasedCredits: credits,
        earnedCredits: d(0),
        heldCredits: d(0),
        totalAvailable: credits,
      },
    });

    // Ledger entry
    const updatedBalance = await tx.userCreditBalance.findUnique({
      where: { userId },
    });
    const newAvailable = updatedBalance
      ? d(updatedBalance.totalAvailable.toString())
      : credits;
    await tx.creditLedger.create({
      data: {
        userId,
        type: "PURCHASE",
        amount: credits,
        balanceBefore: currentAvailable,
        balanceAfter: newAvailable,
        reason: `PURCHASE:${packName}`,
      },
    });
  });
}
