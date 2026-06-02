import { Worker } from "bullmq";
import { redisConnection } from "./queue";
import {
  buildCandidateContextDigest,
  markCandidateDigestFailed,
} from "../session/candidate-digest.service";

export const candidateDigestWorker = new Worker(
  "candidate-digest",
  async (job) => {
    const { sessionId } = job.data as { sessionId: string };
    if (!sessionId) {
      throw new Error("candidate-digest job missing sessionId");
    }

    try {
      await buildCandidateContextDigest(sessionId);
    } catch (error) {
      await markCandidateDigestFailed(sessionId, error);
      throw error;
    }
  },
  { connection: redisConnection },
);

candidateDigestWorker.on("failed", (job, err) => {
  console.error("[candidate-digest] job failed", {
    jobId: job?.id,
    sessionId: job?.data?.sessionId,
    error: err.message,
  });
});

candidateDigestWorker.on("completed", (job) => {
  console.info("[candidate-digest] job completed", {
    jobId: job.id,
    sessionId: job.data?.sessionId,
  });
});
