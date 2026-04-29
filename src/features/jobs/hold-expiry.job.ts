import { Worker } from "bullmq";
import { redisConnection } from "./queue";
import { prisma } from "../../shared/lib/prisma";
import * as creditsService from "../credits/credits.service";
import { SessionStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";

/**
 * Processes hold-expiry jobs.
 * Enqueued by createSession with a 10-minute delay.
 * If the session is still PRE_CHECK when this fires, it was never activated —
 * release the hold (if any) and mark ABANDONED.
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

      const heldAmount = new Prisma.Decimal(session.creditsHeld.toString());

      if (heldAmount.gt(0)) {
        await creditsService.releaseHold(userId, heldAmount, tx);
      }

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
