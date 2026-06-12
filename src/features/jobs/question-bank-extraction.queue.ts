import { Queue } from "bullmq";
import { redisConnection } from "./queue";

export type QuestionBankExtractionJobData = {
  sessionId: string;
};

export const questionBankExtractionQueue = new Queue<QuestionBankExtractionJobData>(
  "question-bank-extraction",
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 200 },
    },
  },
);

export async function enqueueQuestionBankExtraction(sessionId: string): Promise<void> {
  const jobId = `question-bank-extraction-${sessionId}`;

  // BullMQ dedupes by jobId across ALL states, and this queue retains completed
  // and failed jobs (removeOnComplete/removeOnFail counts). Without clearing a
  // prior terminal job first, a session whose extraction already finished — or
  // failed — could never be re-enqueued: add() would silently no-op. Remove any
  // existing job in a terminal state so re-processing always works, but leave an
  // in-flight job (waiting/active/delayed) alone so we never run it twice.
  const existing = await questionBankExtractionQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove();
    } else {
      // Already queued or running — let it finish; don't duplicate.
      return;
    }
  }

  await questionBankExtractionQueue.add(
    "question-bank-extraction",
    { sessionId },
    { jobId },
  );
}
