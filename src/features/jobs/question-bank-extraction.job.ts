import { Worker } from "bullmq";
import { runQuestionBankExtractionForSession } from "../question-bank/question-bank-extraction.service";
import { redisConnection } from "./queue";
import type { QuestionBankExtractionJobData } from "./question-bank-extraction.queue";

console.log("[question-bank-extraction.job.ts] File loaded");

export const questionBankExtractionWorker = new Worker<QuestionBankExtractionJobData>(
  "question-bank-extraction",
  async (job) => {
    await runQuestionBankExtractionForSession(job.data.sessionId);
  },
  { connection: redisConnection, concurrency: 2 },
);

questionBankExtractionWorker.on("failed", (job, error) => {
  console.error("[question-bank-extraction] job failed", {
    jobId: job?.id,
    sessionId: job?.data.sessionId,
    error: error.message,
  });
});

questionBankExtractionWorker.on("completed", (job) => {
  console.info("[question-bank-extraction] job completed", {
    jobId: job.id,
    sessionId: job.data.sessionId,
  });
});
