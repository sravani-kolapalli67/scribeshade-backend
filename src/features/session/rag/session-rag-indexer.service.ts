import crypto from "crypto";
import { EmbeddingService } from "../../ask-ai/embedding.service";
import type {
  AnswerTrust,
  MemoryDoc,
  MemoryDocType,
} from "../session-intelligence.types";
import {
  storeMemoryDocument,
  storeQuestionVector,
} from "./redis-vector-store.service";

export type IndexMemoryDocumentInput = {
  id: string;
  sessionId: string;
  userId: string;
  type: MemoryDocType;
  topic: string;
  text: string;
  speaker?: MemoryDoc["speaker"];
  timestamp: string;
  trust: Exclude<AnswerTrust, "none">;
  answerId?: string;
  projectId?: string;
  codeHash?: string;
};

export function normalizeRagQuestion(question: string): string {
  return question.replace(/\s+/g, " ").trim().toLowerCase();
}

export function hashRagQuestion(question: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeRagQuestion(question))
    .digest("hex");
}

export async function indexMemoryDocument(
  input: IndexMemoryDocumentInput,
): Promise<void> {
  const embeddingService = new EmbeddingService();
  const { embedding } = await embeddingService.generateEmbedding(input.text);
  await storeMemoryDocument({
    ...input,
    embedding,
  });
}

export async function indexQuestionVector(input: {
  sessionId: string;
  question: string;
}): Promise<void> {
  const normalizedQuestion = normalizeRagQuestion(input.question);
  if (!normalizedQuestion) {
    throw new Error("Cannot index an empty RAG question");
  }
  const embeddingService = new EmbeddingService();
  const { embedding } =
    await embeddingService.generateEmbedding(normalizedQuestion);
  await storeQuestionVector({
    sessionId: input.sessionId,
    questionHash: hashRagQuestion(normalizedQuestion),
    embedding,
  });
}
