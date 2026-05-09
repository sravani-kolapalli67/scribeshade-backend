import { Worker } from "bullmq";
import { redisConnection, sessionWatchdogQueue, creditDeductionQueue } from "./queue";
import { prisma } from "../../shared/lib/prisma";
import { creditExhaustionClose } from "../session/session.service";
import { SessionStatus } from "@prisma/client";

/**
 * Time with no heartbeat before we mark a session DISCONNECTED (client gone).
 * The session remains reconnectable for DISCONNECT_TO_AUTOEND_MS more.
 */
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;  // 5 min no heartbeat → DISCONNECTED

/**
 * Time after DISCONNECTED before we auto-end the session and bill the user.
 * Total max "invisible" time = 5 + 5 = 10 min from last heartbeat.
 * Set to same 5-min window so: 5 min silent → DISCONNECTED → 5 more min → AUTO_ENDED
 */
const DISCONNECT_TO_AUTOEND_MS = 5 * 60 * 1000; // 5 min DISCONNECTED → AUTO_ENDED

/**
 * Schedules the watchdog to tick every 60 s.
 * Safe to call multiple times — BullMQ deduplicates repeatable jobs by key.
 */
export async function scheduleWatchdog() {
  await sessionWatchdogQueue.add(
    "watchdog-tick",
    {},
    { repeat: { every: 60_000 }, jobId: "watchdog-tick-recurring" },
  );
}

export const sessionWatchdogWorker = new Worker(
  "session-watchdog",
  async () => {
    const now = new Date();
    const heartbeatCutoff = new Date(now.getTime() - HEARTBEAT_TIMEOUT_MS);
    const autoEndCutoff   = new Date(now.getTime() - DISCONNECT_TO_AUTOEND_MS);

    // ── 1. ACTIVE/PAUSED → DISCONNECTED ────────────────────────────────────
    // Sessions where no heartbeat has been received for > 5 min.
    const staleSessions = await prisma.session.findMany({
      where: {
        status: { in: [SessionStatus.ACTIVE, SessionStatus.PAUSED] },
        OR: [
          // Has heartbeat history but it's stale
          { lastHeartbeatAt: { not: null, lt: heartbeatCutoff } },
          // Never received a heartbeat AND started more than 5 min ago
          { lastHeartbeatAt: null, startedAt: { not: null, lt: heartbeatCutoff } },
        ],
      },
      select: { id: true, lastHeartbeatAt: true, startedAt: true },
    });

    if (staleSessions.length > 0) {
      const staleIds = staleSessions.map((s) => s.id);
      await prisma.session.updateMany({
        where: { id: { in: staleIds } },
        data: { status: SessionStatus.DISCONNECTED, disconnectedAt: now },
      });
      console.log(`[watchdog] ${staleIds.length} session(s) marked DISCONNECTED: ${staleIds.join(", ")}`);
    }

    // ── 2. DISCONNECTED → AUTO_ENDED (bill & finalize) ──────────────────────
    // Sessions that have been DISCONNECTED for > 5 min — client is not coming back.
    const deadSessions = await prisma.session.findMany({
      where: {
        status: SessionStatus.DISCONNECTED,
        disconnectedAt: { not: null, lt: autoEndCutoff },
      },
      select: { id: true, userId: true, disconnectedAt: true },
    });

    for (const session of deadSessions) {
      console.log(
        `[watchdog] Auto-ending session ${session.id} — disconnected at ${session.disconnectedAt?.toISOString()}`,
      );

      // Mark AUTO_ENDED and stamp endedAt
      await prisma.session.update({
        where: { id: session.id },
        data: {
          status: SessionStatus.AUTO_ENDED,
          endedAt: now,
        },
      });

      // Enqueue credit deduction (isAutoEnded=true so final status stays AUTO_ENDED)
      await creditDeductionQueue.add("credit-deduction", {
        sessionId: session.id,
        userId: session.userId,
        isExhausted: false,
        isAutoEnded: true,
      });
    }

    // ── 3. Credit-exhaustion enforcement for still-active sessions ───────────
    // ACTIVE sessions that have blown past their maxAllowedMinutes while still
    // sending heartbeats — the heartbeat should catch this first, but watchdog
    // is the safety net (1-min grace).
    const overrunSessions = await prisma.session.findMany({
      where: {
        status: { in: [SessionStatus.ACTIVE, SessionStatus.PAUSED] },
        maxAllowedMinutes: { not: null },
        startedAt: { not: null },
      },
      select: {
        id: true,
        userId: true,
        startedAt: true,
        maxAllowedMinutes: true,
        pausedDurationSeconds: true,
      },
    });

    for (const session of overrunSessions) {
      if (!session.startedAt || !session.maxAllowedMinutes) continue;

      const activeMs = Math.max(
        0,
        now.getTime() - session.startedAt.getTime() - session.pausedDurationSeconds * 1000,
      );
      const activeMinutes = Math.floor(activeMs / 60000);

      if (activeMinutes >= session.maxAllowedMinutes + 1) {
        console.log(
          `[watchdog] Credit-exhausting session ${session.id}. Active: ${activeMinutes}m, Max: ${session.maxAllowedMinutes}m`,
        );
        await creditExhaustionClose(session.id, session.userId).catch((err) => {
          console.error(`[watchdog] creditExhaustionClose failed for ${session.id}:`, err);
        });
      }
    }
  },
  { connection: redisConnection },
);

sessionWatchdogWorker.on("failed", (job, err) => {
  console.error(`[session-watchdog] job ${job?.id} failed:`, err.message);
});
