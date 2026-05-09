import { Worker } from "bullmq";
import { redisConnection } from "./queue";
import { prisma } from "../../shared/lib/prisma";
import { SessionStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";

/**
 * Processes hold-expiry jobs.
 * Enqueued by createSession with a 10-minute delay.
 * If the session is still PRE_CHECK when this fires, it was never activated —
 * mark ABANDONED (no credits were ever moved, so nothing to release).
 */
export const holdExpiryWorker = new Worker(
  "hold-expiry",
  async (job) => {
    const { sessionId } = job.data as {
      sessionId: string;
      userId: string;
    };

    await prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({ where: { id: sessionId } });
      if (!session || session.status !== SessionStatus.PRE_CHECK) return;

      // No hold system — just mark ABANDONED with 0 credits
      await tx.session.update({
        where: { id: sessionId },
        data: { status: SessionStatus.ABANDONED, creditsHeld: new Prisma.Decimal(0) },
      });
    });

    console.log(`[hold-expiry] session ${sessionId} marked ABANDONED`);
  },
  { connection: redisConnection },
);

holdExpiryWorker.on("failed", (job, err) => {
  console.error(`[hold-expiry] job ${job?.id} failed:`, err.message);
});
