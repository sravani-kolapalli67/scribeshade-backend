import { Worker } from "bullmq";
import { redisConnection, sessionWatchdogQueue } from "./queue";
import { prisma } from "../shared/lib/prisma";
import { creditExhaustionClose } from "../features/session/session.service";
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
    const staleSessions = await prisma.session.findMany({
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
      },
    });

    for (const session of staleSessions) {
      if (!session.startedAt || !session.maxAllowedMinutes) continue;

      // 2-minute buffer beyond maxAllowedMinutes before watchdog intervenes
      const deadlineMs =
        session.startedAt.getTime() +
        (session.maxAllowedMinutes + 2) * 60 * 1_000;

      if (now.getTime() >= deadlineMs) {
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
