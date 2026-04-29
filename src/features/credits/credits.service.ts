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
// Prisma uses its own Decimal class. We work with it via string conversion to
// avoid floating-point drift. All arithmetic uses Prisma.Decimal.

function d(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

type SupportedCurrency = "INR" | "USD" | "GBP";

const INTERVIEW_PACKS: Array<{
  code: string;
  name: string;
  credits: string;
  prices: Record<SupportedCurrency, string>;
}> = [
  {
    code: "quick_5",
    name: "Quick 5",
    credits: "5",
    prices: { INR: "99.00", USD: "2.99", GBP: "2.49" },
  },
  {
    code: "starter_10",
    name: "Starter",
    credits: "10",
    prices: { INR: "149.00", USD: "3.99", GBP: "3.49" },
  },
  {
    code: "basic_25",
    name: "Basic",
    credits: "25",
    prices: { INR: "349.00", USD: "9.99", GBP: "8.99" },
  },
  {
    code: "standard_60",
    name: "Standard",
    credits: "60",
    prices: { INR: "699.00", USD: "19.99", GBP: "17.99" },
  },
  {
    code: "professional_120",
    name: "Professional",
    credits: "120",
    prices: { INR: "1299.00", USD: "39.99", GBP: "34.99" },
  },
  {
    code: "power_300",
    name: "Power",
    credits: "300",
    prices: { INR: "2999.00", USD: "89.99", GBP: "79.99" },
  },
  {
    code: "mega_600",
    name: "Mega",
    credits: "600",
    prices: { INR: "4999.00", USD: "149.99", GBP: "129.99" },
  },
];

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

function toPlanDTO(
  pack: (typeof INTERVIEW_PACKS)[number],
  currency: SupportedCurrency,
): CreditPackPlan {
  const amountMajor = pack.prices[currency];
  return {
    code: pack.code,
    name: pack.name,
    credits: pack.credits,
    currency,
    amountMajor,
    amountMinor: toMinorUnits(amountMajor, currency),
    feature: "INTERVIEW_SESSION",
  };
}

function getRazorpayClient(): Razorpay {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new AppError(500, "Razorpay is not configured");
  }
  return new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });
}

function assertValidRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string,
): void {
  if (!env.RAZORPAY_KEY_SECRET) {
    throw new AppError(500, "Razorpay is not configured");
  }

  const expected = crypto
    .createHmac("sha256", env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  if (expected !== signature) {
    throw new AppError(400, "INVALID_PAYMENT_SIGNATURE");
  }
}

export function getInterviewCreditPlans(
  currencyInput?: string,
): CreditPackPlan[] {
  const currency = normalizeCurrency(currencyInput);
  return INTERVIEW_PACKS.map((pack) => toPlanDTO(pack, currency));
}

export async function createPurchaseOrder(
  userId: string,
  packCode: string,
  currencyInput?: string,
): Promise<PurchaseOrderResult> {
  const currency = normalizeCurrency(currencyInput);
  const pack = INTERVIEW_PACKS.find((item) => item.code === packCode);
  if (!pack) {
    throw new AppError(400, "Invalid packCode");
  }

  const plan = toPlanDTO(pack, currency);
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
    keyId: env.RAZORPAY_KEY_ID!,
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
 * Given available credits, picks the highest bracket the user can afford.
 * Throws AppError(402) if the user cannot afford even the cheapest half-bracket.
 */
export async function computeMaxAllowedMinutes(
  availableCredits: Prisma.Decimal,
): Promise<{
  maxMinutes: number;
  creditsToHold: Prisma.Decimal;
  snapshot: BracketSnapshot;
}> {
  const brackets = await getActiveBrackets();

  if (!brackets.length) {
    throw new AppError(500, "No active credit brackets configured");
  }

  // We use the first bracket for configuration defaults (like freeZoneMinutes)
  const chosen = brackets[0];
  const ratePerMin = 0.5;
  const freeMins = chosen.freeZoneMinutes;

  // Calculate how many paid minutes they can afford: max = freeMins + (available / 0.5)
  const affordablePaidMinutes = Math.floor(availableCredits.toNumber() / ratePerMin);
  
  if (affordablePaidMinutes < 1 && availableCredits.toNumber() < ratePerMin) {
    throw new AppError(402, "INSUFFICIENT_CREDITS");
  }

  const maxMinutes = freeMins + affordablePaidMinutes;
  
  // Hold the entire available balance since we are in a linear model
  const creditsToHold = availableCredits;

  const snapshot: BracketSnapshot = {
    id: chosen.id,
    bracketMinutes: maxMinutes,
    creditsFull: chosen.creditsFull.toString(),
    creditsHalf: chosen.creditsHalf.toString(),
    freeZoneMinutes: chosen.freeZoneMinutes,
    graceZoneMinutes: chosen.graceZoneMinutes,
  };

  return {
    maxMinutes,
    creditsToHold,
    snapshot,
  };
}

// ─── Hold ─────────────────────────────────────────────────────────────────────

/**
 * Places a soft credit lock at session activation.
 * Must be called inside the same Prisma $transaction as the session status update.
 */
export async function placeHold(
  userId: string,
  tx: Prisma.TransactionClient,
): Promise<HoldResult> {
  const balance = await tx.userCreditBalance.findUnique({ where: { userId } });
  if (!balance) throw new AppError(402, "INSUFFICIENT_CREDITS");

  const available = d(balance.totalAvailable.toString());
  const { maxMinutes, creditsToHold, snapshot } =
    await computeMaxAllowedMinutes(available);

  const newHeld = d(balance.heldCredits.toString()).add(creditsToHold);
  const newAvailable = available.sub(creditsToHold);

  await tx.userCreditBalance.update({
    where: { userId },
    data: {
      heldCredits: newHeld,
      totalAvailable: newAvailable,
    },
  });

  return {
    creditsHeld: creditsToHold.toString(),
    maxAllowedMinutes: maxMinutes,
    snapshot,
  };
}

/**
 * Releases a previously placed hold (ABANDONED / PRE_CHECK cleanup).
 * Must be called inside a Prisma $transaction.
 */
export async function releaseHold(
  userId: string,
  creditsHeld: Prisma.Decimal,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const balance = await tx.userCreditBalance.findUnique({ where: { userId } });
  if (!balance) return; // nothing to release

  const newHeld = d(balance.heldCredits.toString()).sub(creditsHeld);
  const newAvailable = d(balance.totalAvailable.toString()).add(creditsHeld);

  await tx.userCreditBalance.update({
    where: { userId },
    data: {
      heldCredits: newHeld.lt(0) ? d(0) : newHeld,
      totalAvailable: newAvailable,
    },
  });
}

// ─── Deduction ────────────────────────────────────────────────────────────────

/**
 * Core bracket deduction. Runs inside a Prisma $transaction.
 *
 * Decision tree:
 *   activeDurationMinutes <= freeZone → FREE_ZONE  (deduct 0)
 *   isExhausted                        → EXHAUSTED  (deduct entire hold)
 *   elapsed >= bracket - graceZone     → FULL_BRACKET
 *   else                               → HALF_BRACKET
 */
export async function deductCredits(
  userId: string,
  sessionId: string,
  activeDurationMinutes: number,
  creditsHeld: Prisma.Decimal,
  snapshot: BracketSnapshot,
  isExhausted: boolean,
  tx: Prisma.TransactionClient,
): Promise<DeductionResult> {
  const {
    freeZoneMinutes,
    graceZoneMinutes,
    bracketMinutes,
    creditsFull,
    creditsHalf,
  } = snapshot;

  // ── Decision tree ──────────────────────────────────────────────────────────
  let deductAmount: Prisma.Decimal;
  let reason: string;

  if (activeDurationMinutes <= freeZoneMinutes) {
    deductAmount = d(0);
    reason = "FREE_ZONE";
  } else if (isExhausted) {
    deductAmount = creditsHeld; // consume entire hold
    reason = "EXHAUSTED";
  } else {
    // Linear deduction: 0.5 credits per minute after free zone
    const paidMinutes = Math.max(0, activeDurationMinutes - freeZoneMinutes);
    deductAmount = d(paidMinutes).mul(0.5);
    reason = "PER_MINUTE_DEDUCTION";

    // Safety: don't deduct more than what was held
    if (deductAmount.gt(creditsHeld)) {
      deductAmount = creditsHeld;
      reason = "CAP_REACHED";
    }
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
      `Hold=${creditsHeld} Deduct=${deductAmount} Reason=${reason}. ` +
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

  // ── Release hold ────────────────────────────────────────────────────────────
  const currentHeld = d(balance.heldCredits.toString());
  const nextHeld = currentHeld.sub(creditsHeld);
  const finalHeld = nextHeld.lt(0) ? d(0) : nextHeld;

  // ── Calculate final availability ───────────────────────────────────────────
  // Formula: totalAvailable = (purchased + earned) - remaining holds
  const nextTotalAvailable = nextPurchased.add(nextEarned).sub(finalHeld);

  await tx.userCreditBalance.update({
    where: { userId },
    data: {
      purchasedCredits: nextPurchased,
      earnedCredits: nextEarned,
      heldCredits: finalHeld,
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
