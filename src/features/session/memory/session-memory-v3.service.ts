import { z } from "zod";
import { redisConnection } from "../../jobs/queue";
import { sessionMemoryV3Key } from "./session-memory.keys";
import type {
  AnswerTrust,
  CodeTaskMemory,
  ScenarioEvidencePacket,
} from "../session-intelligence.types";

const SESSION_MEMORY_TTL_SECONDS = 60 * 60 * 6;

export type TrustedAnswerMemory = {
  answerId: string;
  question: string;
  answerSummary: string;
  topic: string;
  trust: Exclude<AnswerTrust, "none">;
  createdAt: string;
};

export type SessionMemoryV3 = {
  sessionId: string;
  questionChain: string[];
  trustedAnswers: TrustedAnswerMemory[];
  scenarios: ScenarioEvidencePacket[];
  codeTasks: CodeTaskMemory[];
  updatedAt: string;
};

const scenarioSchema = z.object({
  detected: z.boolean(),
  domain: z.string(),
  actors: z.array(z.string()),
  constraints: z.array(z.string()),
  numbers: z.array(z.string()),
  failureSymptom: z.string().optional(),
  finalAsk: z.string(),
  transcriptLines: z.array(z.string()),
  compactQuery: z.string(),
});

const codeTaskSchema = z.object({
  answerId: z.string(),
  question: z.string(),
  language: z.string(),
  codeSummary: z.string(),
  codePreview: z.string(),
  codeHash: z.string(),
  keyFunctions: z.array(z.string()),
  assumptions: z.array(z.string()),
  complexity: z.string().optional(),
  edgeCases: z.array(z.string()),
  topic: z.string(),
});

const sessionMemorySchema = z.object({
  sessionId: z.string().min(1),
  questionChain: z.array(z.string()),
  trustedAnswers: z.array(
    z.object({
      answerId: z.string(),
      question: z.string(),
      answerSummary: z.string(),
      topic: z.string(),
      trust: z.enum(["weak", "strong"]),
      createdAt: z.string().datetime(),
    }),
  ),
  scenarios: z.array(scenarioSchema),
  codeTasks: z.array(codeTaskSchema),
  updatedAt: z.string().datetime(),
});

export function emptySessionMemoryV3(
  sessionId: string,
  updatedAt: string,
): SessionMemoryV3 {
  return {
    sessionId,
    questionChain: [],
    trustedAnswers: [],
    scenarios: [],
    codeTasks: [],
    updatedAt,
  };
}

export async function readSessionMemoryV3(
  sessionId: string,
): Promise<SessionMemoryV3 | null> {
  const key = sessionMemoryV3Key(sessionId);
  const raw = await redisConnection.get(key);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid SessionMemoryV3 JSON for key ${key}: ${message}`,
    );
  }
  const result = sessionMemorySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid SessionMemoryV3 payload for key ${key}: ${result.error.message}`,
    );
  }
  return result.data;
}

export async function writeSessionMemoryV3(
  memory: SessionMemoryV3,
): Promise<void> {
  const validated = sessionMemorySchema.parse(memory);
  await redisConnection.set(
    sessionMemoryV3Key(validated.sessionId),
    JSON.stringify(validated),
    "EX",
    SESSION_MEMORY_TTL_SECONDS,
  );
}
