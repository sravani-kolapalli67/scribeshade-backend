import { Worker } from "bullmq";
import { redisConnection } from "./queue";
import { prisma } from "../../shared/lib/prisma";
import * as creditsService from "../credits/credits.service";
import { SessionStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";

console.log("⚡ [credit-deduction.job.ts] File loaded");

export const creditDeductionWorker = new Worker(
  "credit-deduction",
  async (job) => {
    const {
      sessionId,
      userId,
      isExhausted = false,
      isAutoEnded = false,
    } = job.data as {
      sessionId: string;
      userId: string;
      isExhausted?: boolean;
      isAutoEnded?: boolean;
    };
    console.log(
      `[credit-deduction] Starting job ${job.id} for session ${sessionId} (exhausted=${isExhausted}, autoEnded=${isAutoEnded})`,
    );

    await prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({ where: { id: sessionId } });
      if (!session) return; // already cleaned up

      // Guard: only process valid terminal-in-flight states
      const processableStatuses: SessionStatus[] = [
        SessionStatus.COMPLETING,
        SessionStatus.CREDIT_EXHAUSTED,
        SessionStatus.AUTO_ENDED,
      ];
      if (!processableStatuses.includes(session.status)) {
        console.log(`[credit-deduction] Skipping session ${sessionId} in status ${session.status}`);
        return;
      }

      const snapshot = session.bracketConfigSnapshot as any;
      if (!snapshot) {
        // Free session — just mark COMPLETED
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
        snapshot,
        isExhausted,
        tx,
      );

      // Determine final status
      let finalStatus: SessionStatus = SessionStatus.COMPLETED;
      if (isExhausted) finalStatus = SessionStatus.CREDIT_EXHAUSTED;
      if (isAutoEnded) finalStatus = SessionStatus.AUTO_ENDED;

      await tx.session.update({
        where: { id: sessionId },
        data: {
          status: finalStatus,
          creditsDeducted: new Prisma.Decimal(result.creditsDeducted),
          deductionReason: result.reason as any,
          durationSeconds: totalSeconds,
        },
      });
    });
  },
  { connection: redisConnection, concurrency: 5 },
);

creditDeductionWorker.on("failed", (job, err) => {
  console.error(`[credit-deduction] job ${job?.id} failed:`, err.message);
});

creditDeductionWorker.on("completed", (job) => {
  console.log(
    `[credit-deduction] job ${job.id} completed for session ${job.data.sessionId}`,
  );
});
