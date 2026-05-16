# Credit Deduction System — Implementation Guide

> **Codebase context:** Express 5 + TypeScript + Prisma + Clerk auth + OpenRouter.
> All examples follow existing project conventions: `AppError(statusCode, message)`,
> `requireAuth` / `getCurrentUserId`, `prisma` client from `../../shared/lib/prisma`,
> feature files under `src/features/<name>/`, routes registered in `src/routes/index.ts`.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Phase 1 — Prisma Schema Additions](#2-phase-1--prisma-schema-additions)
3. [Phase 2 — Session Model Migration](#3-phase-2--session-model-migration)
4. [Phase 3 — Credit Feature Module](#4-phase-3--credit-feature-module)
5. [Phase 4 — Session Service Credit Integration](#5-phase-4--session-service-credit-integration)
6. [Phase 5 — BullMQ Background Jobs](#6-phase-5--bullmq-background-jobs)
7. [Phase 6 — API Reference](#7-phase-6--api-reference)
8. [Bracket Deduction Logic](#8-bracket-deduction-logic)
9. [Session State Machine](#9-session-state-machine)
10. [Edge Case Register](#10-edge-case-register)

---

## 1. Architecture Overview

```
src/
├── features/
│   ├── session/           ← extended with credit hold/release logic
│   │   ├── session.router.ts
│   │   ├── session.controller.ts
│   │   ├── session.service.ts      ← activateSession / deactivateSession gain credit calls
│   │   └── session.types.ts
│   └── credits/           ← NEW feature module
│       ├── credits.router.ts
│       ├── credits.controller.ts
│       ├── credits.service.ts      ← core bracket math, hold, deduct, ledger
│       └── credits.types.ts
├── jobs/                  ← NEW BullMQ workers
│   ├── queue.ts            ← Bull queue / Redis client singleton
│   ├── session-watchdog.job.ts
│   ├── credit-deduction.job.ts
│   └── hold-expiry.job.ts
├── routes/
│   └── index.ts           ← add /api/credits mount
└── config/
    └── env.ts             ← add REDIS_URL validation
```

**Key integration points in the existing session lifecycle:**

| Existing endpoint                         | Credit action added                                                  |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `POST /api/session/:id/activate`          | Place credit hold + compute `maxAllowedMinutes`                      |
| `POST /api/session/:id/deactivate`        | Trigger `credit-deduction` BullMQ job                                |
| `POST /api/session/:id/heartbeat` _(new)_ | Enforce `maxAllowedMinutes`; emit `CREDIT_WARNING` or auto-terminate |
| `DELETE /api/session/:id`                 | Release hold if session was `PRE_CHECK` or `ACTIVE`                  |

---

## 2. Phase 1 — Prisma Schema Additions

Add to `prisma/schema.prisma`. Run `pnpm db:migrate` after each phase.

### New Enums

```prisma
enum SessionStatus {
  PRE_CHECK        // hold placed, not yet counting
  ACTIVE
  PAUSED
  COMPLETING       // transitional lock while deduction runs
  COMPLETED
  ABANDONED        // never activated; hold released
  FORCE_ENDED      // watchdog closed
  CREDIT_EXHAUSTED // auto-terminated; all held credits consumed
}

enum LedgerType {
  DEBIT
  PURCHASE
  REFUND
  EARN
}

enum DeductionReason {
  FREE_ZONE
  HALF_BRACKET
  FULL_BRACKET
  EXHAUSTED
  FORCE_ENDED
  REFUND
  BRACKET_OVERFLOW
}

enum PurchaseStatus {
  PENDING
  CONFIRMED
  REFUNDED
}
```

### `CreditConfig` — Bracket rules table

```prisma
model CreditConfig {
  id                 String   @id @default(uuid())
  bracketMinutes     Int      @unique   // 30, 60, …
  creditsFull        Decimal  @db.Decimal(10, 2)
  creditsHalf        Decimal  @db.Decimal(10, 2)
  freeZoneMinutes    Int      @default(5)
  graceZoneMinutes   Int      @default(5)
  isActive           Boolean  @default(true)
  updatedAt          DateTime @updatedAt
}
```

### `UserCreditBalance` — Running balance per user

```prisma
model UserCreditBalance {
  userId            String   @id
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  purchasedCredits  Decimal  @db.Decimal(10, 2) @default(0)
  earnedCredits     Decimal  @db.Decimal(10, 2) @default(0)
  heldCredits       Decimal  @db.Decimal(10, 2) @default(0)
  totalAvailable    Decimal  @db.Decimal(10, 2) @default(0)
  lastUpdated       DateTime @updatedAt
}
```

### `CreditLedger` — Immutable audit log

```prisma
model CreditLedger {
  id            String      @id @default(uuid())
  userId        String
  user          User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  sessionId     String?
  type          LedgerType
  amount        Decimal     @db.Decimal(10, 2)
  balanceBefore Decimal     @db.Decimal(10, 2)
  balanceAfter  Decimal     @db.Decimal(10, 2)
  reason        String
  createdAt     DateTime    @default(now())

  @@index([userId])
  @@index([sessionId])
}
```

### `CreditPurchase` — Payment records

```prisma
model CreditPurchase {
  id                     String        @id @default(uuid())
  userId                 String
  user                   User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  packName               String
  creditsPurchased       Decimal       @db.Decimal(10, 2)
  creditsRemaining       Decimal       @db.Decimal(10, 2)
  paymentProviderEventId String        @unique
  amountPaid             Decimal       @db.Decimal(10, 2)
  currency               String        @default("USD")
  status                 PurchaseStatus @default(PENDING)
  createdAt              DateTime      @default(now())
  confirmedAt            DateTime?

  @@index([userId])
}
```

### User model additions (append to existing `User`)

```prisma
// Add inside model User { … }
creditBalance   UserCreditBalance?
ledgerEntries   CreditLedger[]
purchases       CreditPurchase[]
```

---

## 3. Phase 2 — Session Model Migration

Replace the existing `isActive Boolean` field with the full credit-aware schema. **Do not remove `startedAt` / `endedAt`** — they stay.

```prisma
model Session {
  id                     String        @id @default(uuid())

  // ── existing fields (unchanged) ───────────────────────────────────────────
  companyId              String
  companyName            String
  company                Company       @relation(fields: [companyId], references: [id], onDelete: Restrict)
  jobDescription         String
  resumeId               String
  DocumentId             String
  language               String
  simpleLanguage         Boolean       @default(true)
  extraContext           String
  autoGenerateResponse   Boolean
  saveTranscription      Boolean
  free                   Boolean
  mode                   String
  aiUsage                Int           @default(0)
  messages               Json          @default("[]")
  transcript             Json          @default("[]")
  userId                 String
  user                   User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  questions              QA[]
  feedback               SessionFeedback?
  createdAt              DateTime      @default(now())
  updatedAt              DateTime      @updatedAt

  // ── REPLACED: isActive Boolean → status enum ──────────────────────────────
  status                 SessionStatus @default(PRE_CHECK)

  // ── timing (startedAt / endedAt kept, duration added) ─────────────────────
  startedAt              DateTime?
  endedAt                DateTime?
  durationSeconds        Int?
  pausedDurationSeconds  Int           @default(0)

  // ── credit fields ─────────────────────────────────────────────────────────
  creditsHeld            Decimal       @db.Decimal(10, 2) @default(0)
  creditsDeducted        Decimal?      @db.Decimal(10, 2)
  deductionReason        DeductionReason?
  bracketConfigSnapshot  Json?         // snapshot of CreditConfig at activation
  maxAllowedMinutes      Int?
  creditExhaustedAt      DateTime?

  @@index([userId])
  @@index([companyId])
  @@index([status])
}
```

> **Migration note:** The migration SQL must `ALTER TABLE "Session" ADD COLUMN "status" "SessionStatus" NOT NULL DEFAULT 'PRE_CHECK'` and then `ALTER TABLE "Session" DROP COLUMN "isActive"`. All existing rows get `PRE_CHECK` as default; a one-time data fix should set them to `COMPLETED` if `endedAt IS NOT NULL`, `ACTIVE` if `startedAt IS NOT NULL AND endedAt IS NULL`.

---

## 4. Phase 3 — Credit Feature Module

### `src/features/credits/credits.types.ts`

```typescript
import { Decimal } from "@prisma/client/runtime/library";

export interface BracketSnapshot {
  id: string;
  bracketMinutes: number;
  creditsFull: string; // Decimal serialized as string for JSON
  creditsHalf: string;
  freeZoneMinutes: number;
  graceZoneMinutes: number;
}

export interface HoldResult {
  creditsHeld: Decimal;
  maxAllowedMinutes: number;
  snapshot: BracketSnapshot;
}

export interface DeductionResult {
  creditsDeducted: Decimal;
  reason: string;
  newBalance: Decimal;
}

export interface CreditBalanceDTO {
  userId: string;
  purchasedCredits: string;
  earnedCredits: string;
  heldCredits: string;
  totalAvailable: string;
}
```

### `src/features/credits/credits.service.ts`

```typescript
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import type {
  BracketSnapshot,
  HoldResult,
  DeductionResult,
} from "./credits.types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Banker's rounding (round half to even) for Decimal arithmetic.
 * Prisma Decimal already handles precision; this helper keeps intent explicit.
 */
function toDecimal(value: number | string): Decimal {
  return new Decimal(value);
}

// ─── Balance helpers ──────────────────────────────────────────────────────────

export async function getOrCreateBalance(userId: string) {
  return prisma.userCreditBalance.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      purchasedCredits: 0,
      earnedCredits: 0,
      heldCredits: 0,
      totalAvailable: 0,
    },
  });
}

export async function getCreditBalance(userId: string) {
  return getOrCreateBalance(userId);
}

// ─── Bracket logic ────────────────────────────────────────────────────────────

/**
 * Returns all active brackets ordered ascending by bracketMinutes.
 */
export async function getActiveBrackets() {
  return prisma.creditConfig.findMany({
    where: { isActive: true },
    orderBy: { bracketMinutes: "asc" },
  });
}

/**
 * Returns the best-fit bracket for a given duration in minutes.
 * "Best fit" = smallest bracket whose bracketMinutes >= durationMinutes.
 * Falls back to the largest bracket (BRACKET_OVERFLOW sentinel).
 */
export async function resolveBracket(durationMinutes: number) {
  const brackets = await getActiveBrackets();
  const fit = brackets.find((b) => b.bracketMinutes >= durationMinutes);
  return fit ?? brackets[brackets.length - 1] ?? null;
}

// ─── maxAllowedMinutes ────────────────────────────────────────────────────────

/**
 * Given available credits, returns the highest bracket the user can afford,
 * plus the amount to hold (= credits_full of that bracket).
 */
export async function computeMaxAllowedMinutes(
  availableCredits: Decimal,
): Promise<{
  maxMinutes: number;
  creditsToHold: Decimal;
  snapshot: BracketSnapshot;
}> {
  const brackets = await getActiveBrackets();

  if (!brackets.length) {
    throw new AppError(500, "No active credit brackets configured");
  }

  // Walk brackets ascending; pick the last one still affordable
  let chosen = brackets[0];
  for (const b of brackets) {
    if (new Decimal(b.creditsFull.toString()).lte(availableCredits)) {
      chosen = b;
    }
  }

  const minRequired = new Decimal(brackets[0].creditsHalf.toString());
  if (availableCredits.lt(minRequired)) {
    throw new AppError(402, "INSUFFICIENT_CREDITS");
  }

  const snapshot: BracketSnapshot = {
    id: chosen.id,
    bracketMinutes: chosen.bracketMinutes,
    creditsFull: chosen.creditsFull.toString(),
    creditsHalf: chosen.creditsHalf.toString(),
    freeZoneMinutes: chosen.freeZoneMinutes,
    graceZoneMinutes: chosen.graceZoneMinutes,
  };

  return {
    maxMinutes: chosen.bracketMinutes,
    creditsToHold: new Decimal(chosen.creditsFull.toString()),
    snapshot,
  };
}

// ─── Hold ─────────────────────────────────────────────────────────────────────

/**
 * Places a soft-lock on credits at session activation.
 * Must run inside the same Prisma transaction as the session status update.
 */
export async function placeHold(
  userId: string,
  tx: typeof prisma,
): Promise<HoldResult> {
  const balance = await tx.userCreditBalance.findUnique({ where: { userId } });
  if (!balance) throw new AppError(402, "INSUFFICIENT_CREDITS");

  const available = new Decimal(balance.totalAvailable.toString());
  const { maxMinutes, creditsToHold, snapshot } =
    await computeMaxAllowedMinutes(available);

  const newHeld = new Decimal(balance.heldCredits.toString()).add(
    creditsToHold,
  );
  const newAvailable = available.sub(creditsToHold);

  await tx.userCreditBalance.update({
    where: { userId },
    data: {
      heldCredits: newHeld,
      totalAvailable: newAvailable,
    },
  });

  return {
    creditsHeld: creditsToHold,
    maxAllowedMinutes: maxMinutes,
    snapshot,
  };
}

/**
 * Releases a previously placed hold (ABANDONED / PRE_CHECK cleanup).
 */
export async function releaseHold(
  userId: string,
  creditsHeld: Decimal,
  tx: typeof prisma,
): Promise<void> {
  await tx.userCreditBalance.update({
    where: { userId },
    data: {
      heldCredits: { decrement: creditsHeld },
      totalAvailable: { increment: creditsHeld },
    },
  });
}

// ─── Deduction ────────────────────────────────────────────────────────────────

/**
 * Core deduction logic. Runs inside a Prisma transaction.
 * Returns how much was deducted and why.
 */
export async function deductCredits(
  userId: string,
  sessionId: string,
  actualDurationMinutes: number,
  creditsHeld: Decimal,
  snapshot: BracketSnapshot,
  isExhausted: boolean,
  tx: typeof prisma,
): Promise<DeductionResult> {
  const {
    freeZoneMinutes,
    graceZoneMinutes,
    bracketMinutes,
    creditsFull,
    creditsHalf,
  } = snapshot;

  // ── Decision tree ──────────────────────────────────────────────────────────
  let deductAmount: Decimal;
  let reason: string;

  if (actualDurationMinutes <= freeZoneMinutes) {
    deductAmount = toDecimal(0);
    reason = "FREE_ZONE";
  } else if (isExhausted) {
    deductAmount = creditsHeld; // consume entire hold
    reason = "EXHAUSTED";
  } else if (actualDurationMinutes >= bracketMinutes - graceZoneMinutes) {
    deductAmount = toDecimal(creditsFull);
    reason = "FULL_BRACKET";
  } else {
    deductAmount = toDecimal(creditsHalf);
    reason = "HALF_BRACKET";
  }

  // ── Balance update ─────────────────────────────────────────────────────────
  const balance = await tx.userCreditBalance.findUnique({ where: { userId } });
  if (!balance) throw new AppError(500, "Credit balance not found");

  const balanceBefore = new Decimal(balance.purchasedCredits.toString()).add(
    new Decimal(balance.earnedCredits.toString()),
  );

  // Negative balance guard
  if (balanceBefore.lt(deductAmount)) {
    // Log anomaly but clamp deduction to available — never go negative
    console.error(`[DEDUCTION_ANOMALY] user=${userId} session=${sessionId}`);
    deductAmount = balanceBefore.gt(0) ? balanceBefore : toDecimal(0);
  }

  const balanceAfter = balanceBefore.sub(deductAmount);

  // Release the hold, apply the actual deduction
  const heldAfter = new Decimal(balance.heldCredits.toString()).sub(
    creditsHeld,
  );
  const newPurchased = new Decimal(balance.purchasedCredits.toString()).sub(
    deductAmount,
  );

  await tx.userCreditBalance.update({
    where: { userId },
    data: {
      purchasedCredits: newPurchased.lt(0) ? 0 : newPurchased,
      heldCredits: heldAfter.lt(0) ? 0 : heldAfter,
      totalAvailable: balanceAfter.lt(0) ? 0 : balanceAfter,
    },
  });

  // ── Ledger entry (immutable) ───────────────────────────────────────────────
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

  return { creditsDeducted: deductAmount, reason, newBalance: balanceAfter };
}
```

### `src/features/credits/credits.controller.ts`

```typescript
import { Request, Response, NextFunction } from "express";
import { getCurrentUserId } from "../auth/auth.middleware";
import * as creditsService from "./credits.service";
import { AppError } from "../../shared/middleware/error.middleware";
import { prisma } from "../../shared/lib/prisma";

/**
 * GET /api/credits/balance
 * Returns the caller's current credit balance.
 */
export async function getBalance(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userId = getCurrentUserId(req);
    const user = await prisma.user.findUnique({ where: { clerkId: userId } });
    if (!user) return next(new AppError(404, "User not found"));

    const balance = await creditsService.getCreditBalance(user.id);
    return res.json({ success: true, data: balance });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/credits/ledger
 * Returns paginated ledger entries for the caller.
 */
export async function getLedger(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userId = getCurrentUserId(req);
    const user = await prisma.user.findUnique({ where: { clerkId: userId } });
    if (!user) return next(new AppError(404, "User not found"));

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const [entries, total] = await Promise.all([
      prisma.creditLedger.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.creditLedger.count({ where: { userId: user.id } }),
    ]);

    return res.json({ success: true, data: entries, total, page, limit });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/credits/brackets
 * Returns all active bracket configurations.
 */
export async function getBrackets(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const brackets = await creditsService.getActiveBrackets();
    return res.json({ success: true, data: brackets });
  } catch (err) {
    next(err);
  }
}
```

### `src/features/credits/credits.router.ts`

```typescript
import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import * as creditsController from "./credits.controller";

const router = Router();

router.get("/balance", requireAuth, creditsController.getBalance);
router.get("/ledger", requireAuth, creditsController.getLedger);
router.get("/brackets", creditsController.getBrackets);

export default router;
```

### Register in `src/routes/index.ts`

```typescript
// Add alongside existing route mounts:
import creditsRouter from "../features/credits/credits.router";

// Inside the router setup function:
router.use("/credits", creditsRouter);
```

---

## 5. Phase 4 — Session Service Credit Integration

The existing `activateSession` and `deactivateSession` in `session.service.ts` need credit hooks. The pattern matches how the codebase already calls `prisma` directly in service functions.

### `activateSession` addition

```typescript
// Inside session.service.ts — replace the existing activateSession body:
import * as creditsService from "../credits/credits.service";
import { SessionStatus } from "@prisma/client";

export async function activateSession(sessionId: string, userId: string) {
  // Resolve internal userId from clerkId
  const user = await prisma.user.findUnique({ where: { clerkId: userId } });
  if (!user) throw new AppError(404, "User not found");

  // Run hold + status update atomically
  const result = await prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new AppError(404, "Session not found");
    if (session.userId !== user.id) throw new AppError(403, "Forbidden");

    // Guard: idempotent — already ACTIVE
    if (session.status === SessionStatus.ACTIVE) {
      return {
        session,
        creditsHeld: session.creditsHeld,
        maxAllowedMinutes: session.maxAllowedMinutes,
      };
    }

    // Only PRE_CHECK → ACTIVE is valid
    if (session.status !== SessionStatus.PRE_CHECK) {
      throw new AppError(
        409,
        `Cannot activate a session in status ${session.status}`,
      );
    }

    // Place credit hold
    const holdResult = await creditsService.placeHold(user.id, tx as any);

    const updated = await tx.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.ACTIVE,
        startedAt: new Date(),
        creditsHeld: holdResult.creditsHeld,
        maxAllowedMinutes: holdResult.maxAllowedMinutes,
        bracketConfigSnapshot: holdResult.snapshot as any,
      },
    });

    return {
      session: updated,
      creditsHeld: holdResult.creditsHeld,
      maxAllowedMinutes: holdResult.maxAllowedMinutes,
    };
  });

  return result;
}
```

### `deactivateSession` addition

```typescript
// Inside session.service.ts — replace/extend the existing deactivateSession body:
import { creditDeductionQueue } from "../../jobs/queue";

export async function deactivateSession(
  sessionId: string,
  userId: string,
  aiUsage: number,
  transcript: object,
) {
  const user = await prisma.user.findUnique({ where: { clerkId: userId } });
  if (!user) throw new AppError(404, "User not found");

  // Set COMPLETING transitional lock atomically
  const session = await prisma.$transaction(async (tx) => {
    const s = await tx.session.findUnique({ where: { id: sessionId } });
    if (!s) throw new AppError(404, "Session not found");
    if (s.userId !== user.id) throw new AppError(403, "Forbidden");

    // Idempotency guard
    if (
      s.status === SessionStatus.COMPLETED ||
      s.status === SessionStatus.CREDIT_EXHAUSTED ||
      s.status === SessionStatus.FORCE_ENDED
    ) {
      return s; // already closed, return as-is
    }

    if (
      s.status !== SessionStatus.ACTIVE &&
      s.status !== SessionStatus.PAUSED
    ) {
      throw new AppError(
        409,
        `Cannot deactivate session in status ${s.status}`,
      );
    }

    return tx.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.COMPLETING,
        endedAt: new Date(),
        aiUsage: { increment: aiUsage },
        transcript: transcript as any,
      },
    });
  });

  // Enqueue deduction job (handles ledger + balance + status → COMPLETED)
  await creditDeductionQueue.add("credit-deduction", {
    sessionId,
    userId: user.id,
  });

  // Fire-and-forget analytics (existing behaviour preserved)
  generateSessionFeedback(sessionId).catch(console.error);

  return session;
}
```

### `heartbeat` endpoint (new — enforces maxAllowedMinutes)

Add to `session.controller.ts`:

```typescript
/**
 * POST /api/session/:id/heartbeat
 * Body: { elapsedMinutes: number }
 * Frontend calls this every 60 s while session is ACTIVE.
 */
export async function sessionHeartbeat(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { id } = req.params;
    const { elapsedMinutes } = req.body as { elapsedMinutes: number };

    const session = await prisma.session.findUnique({ where: { id } });
    if (!session || session.status !== SessionStatus.ACTIVE) {
      return res.json({ action: "NONE" });
    }

    const max = session.maxAllowedMinutes ?? Infinity;

    if (elapsedMinutes >= max) {
      // Force-close as CREDIT_EXHAUSTED
      await creditExhaustionClose(id, session.userId);
      return res.json({ action: "CREDIT_EXHAUSTED" });
    }

    if (elapsedMinutes >= max - 1) {
      return res.json({
        action: "CREDIT_WARNING",
        remainingMinutes: max - elapsedMinutes,
      });
    }

    return res.json({ action: "NONE", remainingMinutes: max - elapsedMinutes });
  } catch (err) {
    next(err);
  }
}
```

Add the helper `creditExhaustionClose` to `session.service.ts`:

```typescript
export async function creditExhaustionClose(sessionId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const s = await tx.session.findUnique({ where: { id: sessionId } });
    if (!s || s.status !== SessionStatus.ACTIVE) return;

    await tx.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.CREDIT_EXHAUSTED,
        endedAt: new Date(),
        creditExhaustedAt: new Date(),
      },
    });
  });

  // Enqueue with exhausted flag
  await creditDeductionQueue.add("credit-deduction", {
    sessionId,
    userId,
    isExhausted: true,
  });
}
```

---

## 6. Phase 5 — BullMQ Background Jobs

### Install dependencies

```bash
pnpm add bullmq ioredis
pnpm add -D @types/ioredis
```

Add `REDIS_URL` to `src/config/env.ts` validation.

### `src/jobs/queue.ts`

```typescript
import { Queue, Worker, QueueScheduler } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";

export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // required by BullMQ
});

export const creditDeductionQueue = new Queue("credit-deduction", {
  connection: redisConnection,
});

export const sessionWatchdogQueue = new Queue("session-watchdog", {
  connection: redisConnection,
});

export const holdExpiryQueue = new Queue("hold-expiry", {
  connection: redisConnection,
});
```

### `src/jobs/credit-deduction.job.ts`

```typescript
import { Worker } from "bullmq";
import { redisConnection } from "./queue";
import { prisma } from "../shared/lib/prisma";
import * as creditsService from "../features/credits/credits.service";
import { SessionStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

export const creditDeductionWorker = new Worker(
  "credit-deduction",
  async (job) => {
    const {
      sessionId,
      userId,
      isExhausted = false,
    } = job.data as {
      sessionId: string;
      userId: string;
      isExhausted?: boolean;
    };

    await prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({ where: { id: sessionId } });
      if (!session) return; // already cleaned up

      // Guard: only process if in COMPLETING or CREDIT_EXHAUSTED
      if (
        session.status !== SessionStatus.COMPLETING &&
        session.status !== SessionStatus.CREDIT_EXHAUSTED
      ) {
        return;
      }

      const snapshot = session.bracketConfigSnapshot as any;
      if (!snapshot) {
        // No snapshot means free session — just mark COMPLETED
        await tx.session.update({
          where: { id: sessionId },
          data: { status: SessionStatus.COMPLETED },
        });
        return;
      }

      const endedAt = session.endedAt ?? new Date();
      const startedAt = session.startedAt ?? endedAt;
      const totalSeconds = Math.floor(
        (endedAt.getTime() - startedAt.getTime()) / 1000,
      );
      const activeDurationMinutes = Math.floor(
        (totalSeconds - session.pausedDurationSeconds) / 60,
      );

      const result = await creditsService.deductCredits(
        userId,
        sessionId,
        activeDurationMinutes,
        new Decimal(session.creditsHeld.toString()),
        snapshot,
        isExhausted,
        tx as any,
      );

      await tx.session.update({
        where: { id: sessionId },
        data: {
          status: isExhausted
            ? SessionStatus.CREDIT_EXHAUSTED
            : SessionStatus.COMPLETED,
          creditsDeducted: result.creditsDeducted,
          deductionReason: result.reason as any,
          durationSeconds: totalSeconds,
        },
      });
    });
  },
  { connection: redisConnection, concurrency: 5 },
);
```

### `src/jobs/session-watchdog.job.ts`

```typescript
import { Worker, RepeatOptions } from "bullmq";
import { redisConnection, sessionWatchdogQueue } from "./queue";
import { prisma } from "../shared/lib/prisma";
import { creditExhaustionClose } from "../features/session/session.service";
import { SessionStatus } from "@prisma/client";

// Schedule the watchdog to repeat every 60 s
export async function scheduleWatchdog() {
  await sessionWatchdogQueue.add(
    "watchdog-tick",
    {},
    { repeat: { every: 60_000 } },
  );
}

export const sessionWatchdogWorker = new Worker(
  "session-watchdog",
  async () => {
    const now = new Date();

    // Find ACTIVE sessions where started_at + max_allowed_minutes + 2 min buffer has passed
    const staleSessions = await prisma.session.findMany({
      where: {
        status: { in: [SessionStatus.ACTIVE, SessionStatus.PAUSED] },
        maxAllowedMinutes: { not: null },
        startedAt: { not: null },
      },
    });

    for (const session of staleSessions) {
      if (!session.startedAt || !session.maxAllowedMinutes) continue;

      const deadlineMs =
        session.startedAt.getTime() +
        (session.maxAllowedMinutes + 2) * 60 * 1000;

      if (now.getTime() >= deadlineMs) {
        await creditExhaustionClose(session.id, session.userId).catch(
          console.error,
        );
      }
    }
  },
  { connection: redisConnection },
);
```

### `src/jobs/hold-expiry.job.ts`

```typescript
import { Worker } from "bullmq";
import { redisConnection } from "./queue";
import { prisma } from "../shared/lib/prisma";
import * as creditsService from "../features/credits/credits.service";
import { SessionStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * Releases holds on sessions stuck in PRE_CHECK for > 10 minutes
 * (user opened the setup modal but never pressed Start).
 */
export const holdExpiryWorker = new Worker(
  "hold-expiry",
  async (job) => {
    const { sessionId, userId } = job.data as {
      sessionId: string;
      userId: string;
    };

    await prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({ where: { id: sessionId } });
      if (!session || session.status !== SessionStatus.PRE_CHECK) return;

      await creditsService.releaseHold(
        userId,
        new Decimal(session.creditsHeld.toString()),
        tx as any,
      );

      await tx.session.update({
        where: { id: sessionId },
        data: { status: SessionStatus.ABANDONED, creditsHeld: 0 },
      });
    });
  },
  { connection: redisConnection },
);
```

Start all workers in `src/server.ts` after the server starts:

```typescript
// In src/server.ts (after app.listen):
import { creditDeductionWorker } from "./jobs/credit-deduction.job";
import {
  sessionWatchdogWorker,
  scheduleWatchdog,
} from "./jobs/session-watchdog.job";
import { holdExpiryWorker } from "./jobs/hold-expiry.job";

scheduleWatchdog().catch(console.error);
// Workers auto-start on import; keep references to prevent GC
void creditDeductionWorker;
void sessionWatchdogWorker;
void holdExpiryWorker;
```

---

## 7. Phase 6 — API Reference

All routes below are prefixed with `/api`.

### Credits

| Method | Path                | Auth     | Description                            |
| ------ | ------------------- | -------- | -------------------------------------- |
| `GET`  | `/credits/balance`  | Required | Current balance for authenticated user |
| `GET`  | `/credits/ledger`   | Required | Paginated ledger (`?page=1&limit=20`)  |
| `GET`  | `/credits/brackets` | Public   | Active bracket configs                 |

### Session (credit-integrated)

| Method   | Path                      | Auth     | Description                    | Credit action                                                         |
| -------- | ------------------------- | -------- | ------------------------------ | --------------------------------------------------------------------- |
| `POST`   | `/session/create-session` | Required | Creates session in `PRE_CHECK` | None yet                                                              |
| `POST`   | `/session/:id/activate`   | Required | Start session timer            | Place hold, compute `maxAllowedMinutes`                               |
| `POST`   | `/session/:id/deactivate` | Required | End session                    | Enqueue `credit-deduction` job                                        |
| `POST`   | `/session/:id/heartbeat`  | Required | Tick every 60 s                | Check exhaustion; return `NONE \| CREDIT_WARNING \| CREDIT_EXHAUSTED` |
| `DELETE` | `/session/:id`            | Required | Delete session                 | Release hold if `PRE_CHECK`                                           |

#### `POST /session/:id/activate` — Response

```json
{
  "success": true,
  "sessionId": "uuid",
  "creditsHeld": "0.50",
  "maxAllowedMinutes": 30,
  "timer": 0
}
```

#### `POST /session/:id/heartbeat` — Request / Response

```json
// Request body
{ "elapsedMinutes": 15 }

// Response variants
{ "action": "NONE", "remainingMinutes": 15 }
{ "action": "CREDIT_WARNING", "remainingMinutes": 1 }
{ "action": "CREDIT_EXHAUSTED" }
```

#### `POST /session/:id/deactivate` — Response

```json
{
  "success": true,
  "sessionId": "uuid",
  "status": "COMPLETING"
}
```

> The final `creditsDeducted` and `deductionReason` are written asynchronously by the `credit-deduction` worker. Poll `GET /session/:id` for final state.

---

## 8. Bracket Deduction Logic

```
Given:
  X = activeDurationMinutes  (total seconds − paused seconds, converted)
  snapshot = bracketConfigSnapshot on the session row

Decision tree:
────────────────────────────────────────────────────────
IF X <= snapshot.freeZoneMinutes
    deduct = 0         reason = FREE_ZONE

ELSE IF session.status == CREDIT_EXHAUSTED  (isExhausted flag)
    deduct = creditsHeld   reason = EXHAUSTED

ELSE IF X >= (snapshot.bracketMinutes − snapshot.graceZoneMinutes)
    deduct = creditsFull   reason = FULL_BRACKET

ELSE
    deduct = creditsHalf   reason = HALF_BRACKET
────────────────────────────────────────────────────────

Fallback: if duration exceeds all bracket ceilings (should not happen with
maxAllowedMinutes enforcement), use largest bracket's creditsFull.
Log reason = BRACKET_OVERFLOW and alert.
```

### Example values (default seed)

| Bracket | creditsFull | creditsHalf | freeZone | graceZone |
| ------- | ----------- | ----------- | -------- | --------- |
| 30 min  | 0.50        | 0.25        | 5 min    | 5 min     |
| 60 min  | 1.00        | 0.50        | 5 min    | 5 min     |

**Affordability example:** User has 0.75 credits → can afford 30-min bracket (0.50 ≤ 0.75) but not 60-min (1.00 > 0.75) → `maxAllowedMinutes = 30`, `creditsHeld = 0.50`.

---

## 9. Session State Machine

```
CREATE SESSION
    │
    ▼
 PRE_CHECK ─────────────────────────────────────── hold placed by activateSession
    │                         │
    │ activate                │ never activated (> 10 min)
    ▼                         ▼
  ACTIVE                  ABANDONED  ← hold released, creditsHeld = 0
    │
    ├──── pause ──────▶ PAUSED
    │                      │
    │◀──── resume ──────────┘
    │
    ├──── /deactivate ──────▶ COMPLETING ──▶ COMPLETED
    │                         (worker runs deduction atomically)
    │
    ├──── heartbeat / watchdog ──▶ CREDIT_EXHAUSTED
    │                              (all creditsHeld consumed)
    │
    └──── watchdog crash detect ──▶ FORCE_ENDED
                                    (full bracket deduction at closure time)
```

**Race-condition guard:** `COMPLETING` is set atomically inside `$transaction` before any worker touches the ledger. If `deactivateSession` is called twice concurrently, the second call hits the idempotency guard (`status === COMPLETED → return 200`) without double-deducting.

---

## 10. Edge Case Register

### Session Lifecycle

| Scenario                                   | Status                         | Deduct                                        | Notes                                |
| ------------------------------------------ | ------------------------------ | --------------------------------------------- | ------------------------------------ |
| Never activated (PRE_CHECK > 10 min)       | `ABANDONED`                    | 0                                             | `hold-expiry` job releases hold      |
| Within free zone (≤ 5 min active)          | `COMPLETED`                    | 0                                             | Ledger entry written with amount = 0 |
| Mid-bracket (e.g. 12 of 30 min)            | `COMPLETED`                    | `creditsHalf`                                 | `HALF_BRACKET`                       |
| Grace zone reached (≥ 25 of 30 min)        | `COMPLETED`                    | `creditsFull`                                 | `FULL_BRACKET`                       |
| Exactly at bracket boundary (30.0 min)     | `COMPLETED`                    | `creditsFull`                                 | Boundary inclusive of grace          |
| Credit exhaustion mid-session              | `CREDIT_EXHAUSTED`             | all `creditsHeld`                             | `credit_exhausted_at` recorded       |
| App crash / connection drop                | `FORCE_ENDED`                  | full bracket at closure elapsed time          | Watchdog detects stale ACTIVE        |
| Pause then resume                          | `ACTIVE` → `PAUSED` → `ACTIVE` | Uses `activeDuration = total − pausedSeconds` | Hold NOT released on pause           |
| Pause with no resume (> maxAllowedMinutes) | `FORCE_ENDED`                  | Watchdog applies bracket logic                | Treated like crash                   |
| Duplicate `/deactivate` call               | `COMPLETED` (idempotent 200)   | No double-deduction                           | Status check before $transaction     |
| `/deactivate` after `CREDIT_EXHAUSTED`     | Idempotent 200                 | No change                                     | Guard on status check                |

### Credit Balance

| Scenario                                                   | Behaviour                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Insufficient credits (< `creditsHalf` of smallest bracket) | `AppError(402, "INSUFFICIENT_CREDITS")` on activate                                                  |
| Earned credits change during session                       | Ignored for hold/maxAllowedMinutes; applied at deduction time only                                   |
| Decimal precision                                          | `Decimal(10,2)` throughout; never use `Number()` for credit math                                     |
| Negative balance attempt                                   | `DEDUCTION_ANOMALY` logged; deduction clamped to available; never writes negative `balanceAfter`     |
| Multiple active sessions                                   | `heldCredits` is cumulative; `totalAvailable = purchased + earned − held` checked on each activation |

### Config & Purchase

| Scenario                           | Behaviour                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Config changed after session start | `bracketConfigSnapshot` on session row is always used; live `CreditConfig` never consulted for active sessions |
| No matching bracket                | Largest bracket applied as fallback; logged as `BRACKET_OVERFLOW`                                              |
| Payment webhook delayed            | Credits stay `PENDING`; excluded from `totalAvailable`; UI shows "Purchase processing…"                        |
| Duplicate payment webhook          | `paymentProviderEventId` unique constraint silently deduplicates                                               |
| Refund after partial use           | `creditsRemaining = creditsPurchased − consumed`; only `creditsRemaining` refunded; purchase marked `REFUNDED` |
