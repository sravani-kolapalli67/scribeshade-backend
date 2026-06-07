import { z } from "zod";
import { redisConnection } from "../../jobs/queue";
import { sessionStateV3Key } from "../memory/session-memory.keys";
import type { SessionStateV3 } from "../session-intelligence.types";

const SESSION_STATE_TTL_SECONDS = 60 * 60 * 6;

const interviewerToneSchema = z.enum([
  "neutral",
  "clarification",
  "deep_dive",
  "challenge",
  "skeptical",
  "stress_test",
  "urgency",
]);

const scenarioPacketSchema = z.object({
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

const sessionStateV3Schema = z.object({
  sessionId: z.string().min(1),
  activeTopic: z.string().optional(),
  latestCleanQuestion: z.string().optional(),
  questionChain: z.array(z.string()),
  askState: z.enum([
    "setup_in_progress",
    "answerable_question",
    "provisional_guidance",
    "true_followup",
    "challenge_or_correction",
    "topic_switch",
    "code_task",
  ]),
  interviewerTone: interviewerToneSchema,
  activeScenarioId: z.string().optional(),
  activeCodeTaskId: z.string().optional(),
  activeFollowupTargetId: z.string().optional(),
  updatedAt: z.string().datetime(),
  answeredQuestions: z.array(
    z.object({
      answerId: z.string(),
      question: z.string(),
      answerSummary: z.string(),
      topic: z.string(),
    }),
  ),
  codeTaskState: z
    .object({
      language: z.string().optional(),
      problem: z.string().optional(),
      dataShape: z.string().optional(),
      latestCodeHash: z.string().optional(),
    })
    .optional(),
  scenarioState: scenarioPacketSchema.optional(),
});

export async function readSessionStateV3(
  sessionId: string,
): Promise<SessionStateV3 | null> {
  const key = sessionStateV3Key(sessionId);
  const raw = await redisConnection.get(key);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid SessionStateV3 JSON for key ${key}: ${message}`,
    );
  }

  const result = sessionStateV3Schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid SessionStateV3 payload for key ${key}: ${result.error.message}`,
    );
  }
  return result.data;
}

export async function writeSessionStateV3(
  state: SessionStateV3,
): Promise<void> {
  const validated = sessionStateV3Schema.parse(state);
  await redisConnection.set(
    sessionStateV3Key(validated.sessionId),
    JSON.stringify(validated),
    "EX",
    SESSION_STATE_TTL_SECONDS,
  );
}
