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
  await questionBankExtractionQueue.add(
    "question-bank-extraction",
    { sessionId },
    { jobId: `question-bank-extraction-${sessionId}` },
  );
}
