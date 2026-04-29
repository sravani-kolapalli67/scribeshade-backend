import { Worker } from "bullmq";
import { redisConnection, sessionWatchdogQueue } from "./queue";
import { prisma } from "../../shared/lib/prisma";
import { creditExhaustionClose } from "../session/session.service";
import { SessionStatus } from "@prisma/client";

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

    // Find ACTIVE / PAUSED sessions that have blown past their time limit
    const activeSessions = await prisma.session.findMany({
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

    for (const session of activeSessions) {
      if (!session.startedAt || !session.maxAllowedMinutes) continue;

      const nowMs = now.getTime();
      const startedAtMs = session.startedAt.getTime();
      const pausedMs = session.pausedDurationSeconds * 1000;
      
      const activeMs = Math.max(0, nowMs - startedAtMs - pausedMs);
      const activeMinutes = Math.floor(activeMs / 60000);

      // watchdog intervenes if session has exceeded its limit.
      // We still give a small 1-minute grace to allow heartbeat to handle it gracefully first.
      if (activeMinutes >= session.maxAllowedMinutes + 1) {
        console.log(`[session-watchdog] Auto-closing session ${session.id} for exhaustion. Active: ${activeMinutes}m, Max: ${session.maxAllowedMinutes}m`);
        await creditExhaustionClose(session.id, session.userId).catch((err) => {
          console.error(
            `[session-watchdog] creditExhaustionClose failed for ${session.id}:`,
            err,
          );
        });
      }
    }
  },
  { connection: redisConnection },
);

sessionWatchdogWorker.on("failed", (job, err) => {
  console.error(`[session-watchdog] job ${job?.id} failed:`, err.message);
});
