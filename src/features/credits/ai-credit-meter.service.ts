/**
 * ai-credit-meter.service.ts
 *
 * Centralized financial-safety wrapper for AI operations that consume credits.
 *
 * Guarantees:
 *   1. **Deduct-after-success** — credits are debited only after the AI call
 *      returns a usable result. AI failures cost the user nothing.
 *   2. **Idempotency** — duplicate requests (double-click, retry on transient
 *      error, network replay) sharing an `Idempotency-Key` deduct exactly once
 *      and return the same response.
 *   3. **Race-safe deduction** — uses a conditional `updateMany` with a
 *      `gte: cost` filter so concurrent debits without a shared key cannot
 *      overspend; the second one is rejected with HTTP 402.
 *   4. **Result caching** — for operations that pass `cacheKey`, identical
 *      subsequent calls (e.g. JD-tailor regenerate) are served free from
 *      `AiGenerationCache` for 24h.
 *   5. **Audit trail** — every successful charge writes both `CreditLedger`
 *      (financial) and `CreditUsage` (operational) rows in the same tx.
 *
 * Usage:
 *
 *   const { result, creditsUsed, creditsRemaining, cached } =
 *     await withCreditedAiAction(
 *       {
 *         userId,
 *         operation: "RESUME_ENHANCE_SECTION",
 *         cost: COST_ENHANCE,
 *         idempotencyKey,
 *         resumeId,
 *         metadata: { sectionId },
 *       },
 *       async () => {
 *         const ai = await openrouter.chat.send(...);
 *         return { enhancedText: ai.choices[0].message.content };
 *       },
 *     );
 */

import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

const IDEMPOTENCY_TTL_HOURS = 24;
const CACHE_TTL_HOURS = 24;

export interface AiUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  aiModel?: string;
  aiCostUsd?: string;
}

export interface MeterOptions {
  /** Internal DB UUID (NOT the Clerk ID). */
  userId: string;
  /** Stable operation key, e.g. "RESUME_ENHANCE_SECTION". */
  operation: string;
  /** Credit cost for this operation (resolve via FeatureCost beforehand). */
  cost: Prisma.Decimal;
  /** Optional client-supplied idempotency key (UUID). */
  idempotencyKey?: string | null;
  /** Optional resume association (for ledger / usage rows). */
  resumeId?: string | null;
  /**
   * Optional cache key — if provided, identical inputs are served free from
   * AiGenerationCache. Use a deterministic string (e.g. "jd:" + sha256(jd)).
   */
  cacheKey?: string | null;
  /** Free-form metadata persisted to CreditUsage.metadata. */
  metadata?: Record<string, unknown>;
}

export interface MeterResult<T> {
  result: T;
  creditsUsed: number;
  creditsRemaining: number;
  /** True if served from idempotency replay or generation cache. */
  cached: boolean;
  /** Echo of the idempotency key (if any) for client debugging. */
  idempotencyKey: string | null;
}

/**
 * Shape returned by user-supplied AI callbacks. The `_aiUsage` is optional
 * metadata persisted to CreditUsage for audit; the rest of the object is the
 * payload returned to the caller.
 */
export type AiCallback<T> = () => Promise<T & { _aiUsage?: AiUsageMetrics }>;

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable SHA-256 hash for cache keys. Normalizes whitespace so trivially
 * different inputs (trailing newlines, etc.) collapse to the same key.
 */
export function hashInput(...parts: Array<string | undefined | null>): string {
  const joined = parts
    .map((p) => (p ?? "").replace(/\s+/g, " ").trim().toLowerCase())
    .join("|");
  return crypto.createHash("sha256").update(joined).digest("hex");
}

/**
 * Resolves the credit cost for a feature from the FeatureCost table, falling
 * back to the supplied default if the row is missing or inactive.
 */
export async function getFeatureCost(
  featureKey: string,
  fallback: Prisma.Decimal,
): Promise<Prisma.Decimal> {
  try {
    const row = await prisma.featureCost.findUnique({ where: { featureKey } });
    if (row?.isActive) return new Prisma.Decimal(row.credits.toString());
  } catch {
    // DB unavailable — fall through.
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps an AI call with idempotency, balance pre-check, deduct-after-success,
 * and audit logging.
 *
 * Flow:
 *   1. Idempotency replay → return cached response if key already COMPLETED.
 *   2. Generation cache lookup → return cached payload free if hit.
 *   3. Pre-flight balance check (early reject before AI spend).
 *   4. Insert IdempotencyKey row IN_PROGRESS (acts as in-flight lock).
 *   5. Execute AI callback OUTSIDE any transaction.
 *   6. On AI failure → mark key FAILED, throw. No deduction.
 *   7. On AI success → atomic tx:
 *        a. Race-safe `updateMany` debits balance.
 *        b. Write CreditLedger + CreditUsage rows.
 *        c. Update IdempotencyKey to COMPLETED with cached body.
 *        d. Persist AiGenerationCache row if cacheKey supplied.
 */
export async function withCreditedAiAction<T extends Record<string, unknown>>(
  opts: MeterOptions,
  aiCall: AiCallback<T>,
): Promise<MeterResult<T>> {
  const { userId, operation, cost, resumeId, metadata } = opts;
  const idempotencyKey = opts.idempotencyKey?.trim() || null;
  const cacheKey = opts.cacheKey?.trim() || null;

  if (!userId) throw new AppError(400, "userId is required");
  if (cost.lt(0)) throw new AppError(500, "Invalid feature cost");

  // ─── 1. Idempotency replay ────────────────────────────────────────────────
  if (idempotencyKey) {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { key: idempotencyKey },
    });
    if (existing) {
      if (existing.userId !== userId) {
        throw new AppError(409, "Idempotency key conflict");
      }
      if (existing.operation !== operation) {
        throw new AppError(
          409,
          `Idempotency key reused for different operation (was ${existing.operation})`,
        );
      }
      if (existing.status === "COMPLETED" && existing.responseBody) {
        const balance = await readBalance(userId);
        return {
          result: existing.responseBody as T,
          creditsUsed: Number(existing.creditsUsed ?? 0),
          creditsRemaining: balance,
          cached: true,
          idempotencyKey,
        };
      }
      if (existing.status === "IN_PROGRESS") {
        throw new AppError(
          409,
          "Operation already in progress for this idempotency key",
        );
      }
      // FAILED → fall through and allow retry. Drop the stale row first so
      // the unique-constraint create below succeeds.
      await prisma.idempotencyKey
        .delete({ where: { key: idempotencyKey } })
        .catch(() => undefined);
    }
  }

  // ─── 2. Generation cache lookup (free regenerate) ─────────────────────────
  if (cacheKey) {
    const cached = await prisma.aiGenerationCache.findUnique({
      where: {
        userId_operation_resumeId_inputHash: {
          userId,
          operation,
          resumeId: resumeId ?? "",
          inputHash: cacheKey,
        },
      },
    });
    if (cached && cached.expiresAt > new Date()) {
      const balance = await readBalance(userId);
      // Persist a zero-cost CreditUsage row so analytics still capture the
      // cache hit; no ledger entry since no money moved.
      await prisma.creditUsage
        .create({
          data: {
            userId,
            resumeId: resumeId ?? null,
            operation,
            creditsUsed: new Prisma.Decimal(0),
            cached: true,
            metadata: metadata as Prisma.InputJsonValue,
          },
        })
        .catch(() => undefined);
      return {
        result: cached.responseBody as T,
        creditsUsed: 0,
        creditsRemaining: balance,
        cached: true,
        idempotencyKey,
      };
    }
  }

  // ─── 3. Pre-flight balance check ──────────────────────────────────────────
  const balanceRow = await prisma.userCreditBalance.findUnique({
    where: { userId },
  });
  if (!balanceRow) {
    throw new AppError(
      402,
      `Insufficient credits. Required: ${cost.toString()}, Available: 0`,
    );
  }
  const available = new Prisma.Decimal(balanceRow.totalAvailable.toString());
  if (available.lt(cost)) {
    throw new AppError(
      402,
      `Insufficient credits. Required: ${cost.toString()}, Available: ${available.toString()}`,
    );
  }

  // ─── 4. Reserve idempotency slot (in-flight lock) ─────────────────────────
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600_000);
  if (idempotencyKey) {
    try {
      await prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          userId,
          operation,
          status: "IN_PROGRESS",
          expiresAt,
        },
      });
    } catch (err) {
      // Concurrent duplicate raced us — re-read and behave like step 1.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const racing = await prisma.idempotencyKey.findUnique({
          where: { key: idempotencyKey },
        });
        if (racing?.status === "COMPLETED" && racing.responseBody) {
          return {
            result: racing.responseBody as T,
            creditsUsed: Number(racing.creditsUsed ?? 0),
            creditsRemaining: await readBalance(userId),
            cached: true,
            idempotencyKey,
          };
        }
        throw new AppError(
          409,
          "Operation already in progress for this idempotency key",
        );
      }
      throw err;
    }
  }

  // ─── 5. Execute AI call (outside tx — slow + may fail) ────────────────────
  let aiResult: T & { _aiUsage?: AiUsageMetrics };
  try {
    aiResult = await aiCall();
  } catch (err) {
    if (idempotencyKey) {
      await prisma.idempotencyKey
        .update({
          where: { key: idempotencyKey },
          data: { status: "FAILED", completedAt: new Date() },
        })
        .catch(() => undefined);
    }
    throw err;
  }

  const usage = aiResult._aiUsage;
  // Strip internal field from the payload returned to the client.
  const responsePayload = { ...aiResult } as T & { _aiUsage?: AiUsageMetrics };
  delete responsePayload._aiUsage;

  // ─── 6. Atomic deduction + audit + cache (race-safe) ──────────────────────
  const finalBalance = await prisma.$transaction(async (tx) => {
    // Conditional update: only decrement if balance still >= cost. If a
    // concurrent operation drained it between step 3 and now, count === 0
    // and we throw. AI cost is absorbed (we already paid OpenRouter) but
    // the user is not charged — preferable to silent overspend.
    const updated = await tx.userCreditBalance.updateMany({
      where: { userId, totalAvailable: { gte: cost } },
      data: { totalAvailable: { decrement: cost } },
    });

    if (updated.count === 0) {
      // We can't deduct; do not write a ledger entry. Mark idempotency
      // FAILED so the client can prompt the user to top up and retry.
      throw new AppError(
        402,
        "Insufficient credits at time of deduction (concurrent debit drained balance)",
      );
    }

    const refreshed = await tx.userCreditBalance.findUnique({
      where: { userId },
    });
    const after = new Prisma.Decimal(refreshed!.totalAvailable.toString());
    const before = after.plus(cost);

    await tx.creditLedger.create({
      data: {
        userId,
        type: "DEBIT",
        amount: cost,
        balanceBefore: before,
        balanceAfter: after,
        reason: operation,
      },
    });

    await tx.creditUsage.create({
      data: {
        userId,
        resumeId: resumeId ?? null,
        operation,
        creditsUsed: cost,
        aiModel: usage?.aiModel ?? null,
        aiCostUsd: usage?.aiCostUsd
          ? new Prisma.Decimal(usage.aiCostUsd)
          : null,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cached: false,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });

    if (idempotencyKey) {
      await tx.idempotencyKey.update({
        where: { key: idempotencyKey },
        data: {
          status: "COMPLETED",
          responseBody: responsePayload as Prisma.InputJsonValue,
          statusCode: 200,
          creditsUsed: cost,
          completedAt: new Date(),
        },
      });
    }

    if (cacheKey) {
      const cacheExpires = new Date(Date.now() + CACHE_TTL_HOURS * 3600_000);
      await tx.aiGenerationCache.upsert({
        where: {
          userId_operation_resumeId_inputHash: {
            userId,
            operation,
            resumeId: resumeId ?? "",
            inputHash: cacheKey,
          },
        },
        create: {
          userId,
          operation,
          resumeId: resumeId ?? "",
          inputHash: cacheKey,
          responseBody: responsePayload as Prisma.InputJsonValue,
          creditsCharged: cost,
          expiresAt: cacheExpires,
        },
        update: {
          responseBody: responsePayload as Prisma.InputJsonValue,
          creditsCharged: cost,
          expiresAt: cacheExpires,
        },
      });
    }

    return after.toNumber();
  });

  return {
    result: responsePayload,
    creditsUsed: cost.toNumber(),
    creditsRemaining: finalBalance,
    cached: false,
    idempotencyKey,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

async function readBalance(userId: string): Promise<number> {
  const row = await prisma.userCreditBalance.findUnique({ where: { userId } });
  if (!row) return 0;
  return new Prisma.Decimal(row.totalAvailable.toString()).toNumber();
}
