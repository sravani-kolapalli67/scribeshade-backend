import type { AnswerTrust } from "../session/session-intelligence.types";
import { sessionMemoryQueue } from "./queue";

export type SessionMemoryJobData =
  | {
      type: "memory-update";
      sessionId: string;
      answerId?: string;
      question?: string;
      answer?: string;
      trust?: Exclude<AnswerTrust, "none">;
    }
  | {
      type: "scenario-update";
      sessionId: string;
      currentQuestionHint?: string;
    }
  | {
      type: "code-task-update";
      sessionId: string;
      answerId: string;
      question: string;
      answer: string;
      topic: string;
      explicitCodeTask: boolean;
    };

export async function enqueueSessionMemoryJob(
  data: SessionMemoryJobData,
): Promise<void> {
  const identity =
    data.type === "code-task-update"
      ? data.answerId
      : data.type === "memory-update"
        ? data.answerId || data.question || "transcript"
        : data.currentQuestionHint || "scenario";
  const jobId = `${data.type}-${data.sessionId}-${identity}`
    .replace(/[^a-zA-Z0-9:_-]/g, "-")
    .replace(/:/g, "-")
    .slice(0, 180);
  await sessionMemoryQueue.add(data.type, data, { jobId });
}
