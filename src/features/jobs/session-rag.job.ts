import { Worker } from "bullmq";
import {
  indexMemoryDocument,
  indexQuestionVector,
} from "../session/rag/session-rag-indexer.service";
import { redisConnection } from "./queue";
import type { SessionRagJobData } from "./session-rag.queue";

export const sessionRagWorker = new Worker(
  "session-rag",
  async (job) => {
    const data = job.data as SessionRagJobData;
    if (data.type === "index-document") {
      await indexMemoryDocument(data.document);
      return;
    }
    if (data.type === "index-question") {
      await indexQuestionVector(data);
      return;
    }
    throw new Error(`Unsupported session-rag job type: ${job.name}`);
  },
  { connection: redisConnection },
);

sessionRagWorker.on("failed", (job, error) => {
  console.error("[session-rag] job failed", {
    jobId: job?.id,
    type: job?.name,
    sessionId:
      job?.data?.sessionId || job?.data?.document?.sessionId,
    error: error.message,
  });
});
