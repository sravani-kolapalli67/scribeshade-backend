import type {
  IndexMemoryDocumentInput,
} from "../session/rag/session-rag-indexer.service";
import { sessionRagQueue } from "./queue";

export type SessionRagJobData =
  | {
      type: "index-document";
      document: IndexMemoryDocumentInput;
    }
  | {
      type: "index-question";
      sessionId: string;
      question: string;
    };

export async function enqueueSessionRagJob(
  data: SessionRagJobData,
): Promise<void> {
  const identity =
    data.type === "index-document"
      ? data.document.id
      : data.question;
  const sessionId =
    data.type === "index-document"
      ? data.document.sessionId
      : data.sessionId;
  const jobId = `${data.type}-${sessionId}-${identity}`
    .replace(/[^a-zA-Z0-9:_-]/g, "-")
    .replace(/:/g, "-")
    .slice(0, 180);
  await sessionRagQueue.add(data.type, data, { jobId });
}
