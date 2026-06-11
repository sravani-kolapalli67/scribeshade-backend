import { Prisma, SessionAIAnswerStatus } from "@prisma/client";
import { prisma } from "../../shared/lib/prisma";
import {
  deriveTopicFromAnyText,
  extractCodeBlocksFromText,
} from "./answer-quality";

export type LatestSuccessfulAnswer = {
  id: string;
  question: string;
  answer: string;
  topic: string;
  createdAt: Date;
  codeBlocks: string[];
  source: "db_ledger" | "redis_ledger" | "frontend_metadata" | "transcript_history";
};

export type AIAnswerLedgerWriteInput = {
  sessionId: string;
  question: string;
  answerText: string;
  intent: string;
  topic?: string;
  confidence: number;
  sourceTranscriptRange?: Prisma.InputJsonValue;
  answerStatus: SessionAIAnswerStatus;
  messageId?: string;
  qaId?: string;
  failureReason?: string;
};

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function clip(text: string, maxChars: number): string {
  const normalized = normalizeSpaces(text);
  return normalized.length <= maxChars
    ? normalized
    : normalized.slice(0, maxChars).trim();
}

export async function createAIAnswerLedgerEntry(
  input: AIAnswerLedgerWriteInput,
): Promise<{ id: string }> {
  const answerText = clip(input.answerText, 30_000);
  const question = clip(input.question, 4_000);
  const topic =
    input.topic ||
    deriveTopicFromAnyText(`${question} ${answerText}`) ||
    "general";
  const codeBlocks = extractCodeBlocksFromText(answerText);
  const row = await prisma.sessionAIAnswerLedger.create({
    data: {
      sessionId: input.sessionId,
      question,
      answerText,
      topic,
      intent: input.intent,
      sourceTranscriptRange: input.sourceTranscriptRange,
      answerStatus: input.answerStatus,
      hasCode: codeBlocks.length > 0,
      confidence: input.confidence,
      messageId: input.messageId,
      qaId: input.qaId,
      failureReason: input.failureReason,
    },
    select: { id: true },
  });
  return row;
}

export async function markAIAnswerLedgerSaved(input: {
  id: string;
  messageId?: string;
  qaId?: string;
}): Promise<void> {
  await prisma.sessionAIAnswerLedger.update({
    where: { id: input.id },
    data: {
      answerStatus: SessionAIAnswerStatus.SAVED,
      messageId: input.messageId,
      qaId: input.qaId,
      failureReason: null,
    },
  });
}

export async function markAIAnswerLedgerStreamedValidSaveFailed(input: {
  id: string;
  failureReason: string;
}): Promise<void> {
  await prisma.sessionAIAnswerLedger.update({
    where: { id: input.id },
    data: {
      answerStatus: SessionAIAnswerStatus.STREAMED_VALID_SAVE_FAILED,
      failureReason: clip(input.failureReason, 2_000),
    },
  });
}

export async function getLatestSuccessfulAIAnswer(
  sessionId: string,
): Promise<LatestSuccessfulAnswer | null> {
  const row = await prisma.sessionAIAnswerLedger.findFirst({
    where: {
      sessionId,
      answerStatus: SessionAIAnswerStatus.SAVED,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!row) return null;
  return {
    id: row.messageId || row.id,
    question: row.question,
    answer: row.answerText,
    topic: row.topic,
    createdAt: row.createdAt,
    codeBlocks: extractCodeBlocksFromText(row.answerText),
    source: "db_ledger",
  };
}
