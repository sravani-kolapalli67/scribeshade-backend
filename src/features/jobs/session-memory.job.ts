import { Worker } from "bullmq";
import { prisma } from "../../shared/lib/prisma";
import { deriveTopicFromAnyText } from "../session/answer-quality";
import { buildCodeTaskMemory } from "../session/memory/code-task-memory.service";
import {
  emptySessionMemoryV3,
  readSessionMemoryV3,
  writeSessionMemoryV3,
} from "../session/memory/session-memory-v3.service";
import { readAnswerLedger, readIntentLedger } from "../session/question-composer.service";
import { buildSessionStateV3 } from "../session/session-intelligence.service";
import type {
  SanitizedLiveRequest,
} from "../session/session-intelligence.types";
import { writeSessionStateV3 } from "../session/state/session-state-v3.service";
import { buildScenarioEvidencePacket } from "../session/transcript/scenario-evidence-builder";
import type { TranscriptEvidenceLine } from "../session/ai-answer-context-guards";
import { redisConnection } from "./queue";
import type { SessionMemoryJobData } from "./session-memory.queue";

function workerSanitizedRequest(
  latestQuestion: string,
): SanitizedLiveRequest {
  return {
    kind: "latest_question",
    effectiveAnswerClickMode: "answer_latest_unanswered",
    metadata: { answerClickMode: "answer_latest_unanswered" },
    latestQuestionHint: latestQuestion,
    allowSelectedAnswer: false,
    allowPreviousAnswer: false,
    allowPreviousAnswers: false,
    allowCodeMemory: false,
    allowProjectContext: false,
    allowHistory: false,
    answerKind: "final",
    answerTrust: "strong",
    interviewerTone: "neutral",
    scenarioDetected: false,
  };
}

async function loadTranscriptLines(
  sessionId: string,
): Promise<TranscriptEvidenceLine[]> {
  const chunks = await prisma.transcriptChunk.findMany({
    where: { sessionId },
    orderBy: { startTime: "asc" },
    take: 80,
    select: {
      id: true,
      content: true,
      speakerType: true,
      startTime: true,
    },
  });
  return chunks.map((chunk) => ({
    speaker:
      String(chunk.speakerType).toLowerCase() === "interviewer"
        ? "interviewer"
        : "candidate",
    text: chunk.content,
    chunkId: chunk.id,
    timestamp: Number(chunk.startTime),
    source: "db",
  }));
}

async function updateStateAndMemory(
  data: Extract<SessionMemoryJobData, { type: "memory-update" }>,
): Promise<void> {
  const [intentLedger, answerLedger, existingMemory] = await Promise.all([
    readIntentLedger(data.sessionId),
    readAnswerLedger(data.sessionId),
    readSessionMemoryV3(data.sessionId),
  ]);
  const latestQuestion =
    data.question || intentLedger.intents.at(-1)?.question || "";
  const state = buildSessionStateV3({
    sessionId: data.sessionId,
    sanitizedRequest: workerSanitizedRequest(latestQuestion),
    intentLedger,
    answerLedger,
    fallbackTopic: deriveTopicFromAnyText(latestQuestion),
  });
  const now = new Date().toISOString();
  const memory =
    existingMemory || emptySessionMemoryV3(data.sessionId, now);
  const trustedAnswers =
    data.answerId && data.question && data.answer && data.trust
      ? [
          ...memory.trustedAnswers.filter(
            (entry) => entry.answerId !== data.answerId,
          ),
          {
            answerId: data.answerId,
            question: data.question,
            answerSummary: data.answer.slice(0, 800),
            topic: deriveTopicFromAnyText(data.question),
            trust: data.trust,
            createdAt: now,
          },
        ].slice(-20)
      : memory.trustedAnswers;

  await Promise.all([
    writeSessionStateV3(state),
    writeSessionMemoryV3({
      ...memory,
      questionChain: state.questionChain,
      trustedAnswers,
      updatedAt: now,
    }),
  ]);
}

async function updateScenarioMemory(
  data: Extract<SessionMemoryJobData, { type: "scenario-update" }>,
): Promise<void> {
  const lines = await loadTranscriptLines(data.sessionId);
  const packet = buildScenarioEvidencePacket({
    lines,
    currentQuestionHint: data.currentQuestionHint,
  });
  if (!packet) return;
  const now = new Date().toISOString();
  const memory =
    (await readSessionMemoryV3(data.sessionId)) ||
    emptySessionMemoryV3(data.sessionId, now);
  await writeSessionMemoryV3({
    ...memory,
    scenarios: [
      ...memory.scenarios.filter(
        (scenario) => scenario.compactQuery !== packet.compactQuery,
      ),
      packet,
    ].slice(-8),
    updatedAt: now,
  });
}

async function updateCodeTaskMemory(
  data: Extract<SessionMemoryJobData, { type: "code-task-update" }>,
): Promise<void> {
  const codeTask = buildCodeTaskMemory(data);
  if (!codeTask) return;
  const now = new Date().toISOString();
  const memory =
    (await readSessionMemoryV3(data.sessionId)) ||
    emptySessionMemoryV3(data.sessionId, now);
  await writeSessionMemoryV3({
    ...memory,
    codeTasks: [
      ...memory.codeTasks.filter(
        (entry) => entry.answerId !== codeTask.answerId,
      ),
      codeTask,
    ].slice(-10),
    updatedAt: now,
  });
}

export const sessionMemoryWorker = new Worker(
  "session-memory",
  async (job) => {
    const data = job.data as SessionMemoryJobData;
    if (data.type === "memory-update") {
      await updateStateAndMemory(data);
      return;
    }
    if (data.type === "scenario-update") {
      await updateScenarioMemory(data);
      return;
    }
    if (data.type === "code-task-update") {
      await updateCodeTaskMemory(data);
      return;
    }
    throw new Error(`Unsupported session-memory job type: ${job.name}`);
  },
  { connection: redisConnection },
);

sessionMemoryWorker.on("failed", (job, error) => {
  console.error("[session-memory] job failed", {
    jobId: job?.id,
    type: job?.name,
    sessionId: job?.data?.sessionId,
    error: error.message,
  });
});
