import { z } from "zod";
import { redisConnection } from "../../jobs/queue";
import type {
  MemoryDoc,
  MemoryDocType,
} from "../session-intelligence.types";

const MEMORY_DOC_TTL_SECONDS = 60 * 60 * 24;

const memoryDocSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  type: z.enum([
    "transcript_turn",
    "clean_question",
    "qa_summary",
    "code_task",
    "code_block",
    "scenario_packet",
    "candidate_fact",
    "project_fact",
    "resume_fact",
    "interviewer_challenge",
  ]),
  topic: z.string(),
  text: z.string().min(1),
  speaker: z.enum(["interviewer", "candidate", "assistant"]).optional(),
  timestamp: z.string().datetime(),
  trust: z.enum(["weak", "strong"]),
  answerId: z.string().optional(),
  projectId: z.string().optional(),
  codeHash: z.string().optional(),
  embedding: z.array(z.number()).min(1),
});

function documentSetKey(sessionId: string): string {
  return `session:${sessionId}:rag:v3:documents`;
}

function documentKey(sessionId: string, documentId: string): string {
  return `session:${sessionId}:rag:v3:document:${documentId}`;
}

export function questionVectorKey(
  sessionId: string,
  questionHash: string,
): string {
  return `session:${sessionId}:rag:v3:question:${questionHash}`;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return -1;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function parseStoredJson(input: {
  raw: string;
  key: string;
}): unknown {
  try {
    return JSON.parse(input.raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON stored at Redis key ${input.key}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function storeMemoryDocument(
  document: MemoryDoc,
): Promise<void> {
  const validated = memoryDocSchema.parse(document);
  const key = documentKey(validated.sessionId, validated.id);
  const transaction = redisConnection.multi();
  transaction.set(
    key,
    JSON.stringify(validated),
    "EX",
    MEMORY_DOC_TTL_SECONDS,
  );
  transaction.sadd(documentSetKey(validated.sessionId), validated.id);
  transaction.expire(
    documentSetKey(validated.sessionId),
    MEMORY_DOC_TTL_SECONDS,
  );
  const results = await transaction.exec();
  if (!results) {
    throw new Error(
      `Redis transaction failed while storing memory document ${validated.id}`,
    );
  }
  const transactionError = results.find(([error]) => error)?.[0];
  if (transactionError) {
    throw new Error(
      `Redis transaction failed while storing memory document ${validated.id}: ${transactionError.message}`,
    );
  }
}

export async function storeQuestionVector(input: {
  sessionId: string;
  questionHash: string;
  embedding: number[];
}): Promise<void> {
  if (input.embedding.length === 0) {
    throw new Error("Cannot store an empty question embedding");
  }
  await redisConnection.set(
    questionVectorKey(input.sessionId, input.questionHash),
    JSON.stringify(input.embedding),
    "EX",
    MEMORY_DOC_TTL_SECONDS,
  );
}

export async function readQuestionVector(input: {
  sessionId: string;
  questionHash: string;
}): Promise<number[] | null> {
  const key = questionVectorKey(input.sessionId, input.questionHash);
  const raw = await redisConnection.get(key);
  if (!raw) return null;
  const parsed = z
    .array(z.number())
    .min(1)
    .safeParse(parseStoredJson({ raw, key }));
  if (!parsed.success) {
    throw new Error(`Invalid question vector stored at ${key}`);
  }
  return parsed.data;
}

export async function searchMemoryDocuments(input: {
  sessionId: string;
  userId: string;
  queryEmbedding: number[];
  includeTypes: MemoryDocType[];
  topicFilters: string[];
  trustFilter: MemoryDoc["trust"][];
  limit: number;
}): Promise<Array<{ document: MemoryDoc; score: number }>> {
  const ids = await redisConnection.smembers(
    documentSetKey(input.sessionId),
  );
  if (ids.length === 0) return [];
  const pipeline = redisConnection.pipeline();
  for (const id of ids) {
    pipeline.get(documentKey(input.sessionId, id));
  }
  const values = await pipeline.exec();
  if (!values) {
    throw new Error(
      `Redis pipeline failed while reading RAG documents for ${input.sessionId}`,
    );
  }
  const allowedTypes = new Set(input.includeTypes);
  const allowedTrust = new Set(input.trustFilter);
  const normalizedTopics = input.topicFilters.map((topic) =>
    topic.toLowerCase(),
  );

  return values
    .flatMap(([error, raw], index) => {
      if (error) throw error;
      if (typeof raw !== "string") return [];
      const key = documentKey(input.sessionId, ids[index]);
      const parsed = memoryDocSchema.safeParse(
        parseStoredJson({ raw, key }),
      );
      if (!parsed.success) {
        throw new Error(
          `Invalid RAG memory document in session ${input.sessionId}: ${parsed.error.message}`,
        );
      }
      const document = parsed.data;
      if (
        document.sessionId !== input.sessionId ||
        document.userId !== input.userId ||
        !allowedTypes.has(document.type) ||
        !allowedTrust.has(document.trust)
      ) {
        return [];
      }
      if (
        normalizedTopics.length > 0 &&
        document.topic &&
        !normalizedTopics.includes(document.topic.toLowerCase())
      ) {
        return [];
      }
      return [
        {
          document,
          score: cosineSimilarity(
            input.queryEmbedding,
            document.embedding,
          ),
        },
      ];
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit);
}
