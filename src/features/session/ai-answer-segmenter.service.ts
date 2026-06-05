import crypto from "crypto";
import { Prisma, SpeakerType } from "@prisma/client";
import { prisma } from "../../shared/lib/prisma";
import { redisConnection } from "../jobs/queue";
import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";
import type { AISessionDecision } from "./ai-session-decision";
import { deriveTopicFromAnyText } from "./answer-quality";
import { reconstructFallbackQuestion } from "./question-quality.service";

type SegmenterSpeaker = "interviewer" | "candidate" | "assistant" | "system" | "unknown";
type SegmenterSource = "ai" | "fallback";

export type SegmenterTranscriptChunk = {
  id: string;
  transcriptChunkId?: string;
  messageId?: string;
  speaker: SegmenterSpeaker;
  text: string;
  timestamp: number;
  source: "db" | "payload" | "redis";
};

export type SegmenterIntent = {
  id: string;
  question: string;
  speakerOrigin: SegmenterSpeaker;
  status: "unanswered" | "answered" | "ignored";
  relevance: "active" | "related" | "stale" | "filler";
  confidence: number;
  transcriptChunkIds: string[];
  relatedIntentIds: string[];
  reason: string;
};

export type SegmenterCheckpointMemory = {
  snapshotId: string;
  resolvedIntentIds: string[];
  questionGenerated: string;
  detectedIntent: string;
  sessionStateSummary: string;
  confidence: number;
  createdAt: string;
};

export type SessionSegmenterMemory = {
  transcriptChunks: SegmenterTranscriptChunk[];
  answerCheckpoints: SegmenterCheckpointMemory[];
  sessionStateSummary: string;
  activeUnresolvedIntentIds: string[];
  resolvedIntentIds: string[];
  updatedAt: string;
};

export type AIAnswerSegmenterResult = {
  source: SegmenterSource;
  boundedTranscript: SegmenterTranscriptChunk[];
  intentsToAnswer: SegmenterIntent[];
  latestIntentId: string | null;
  relatedPendingIntentIds: string[];
  resolvedIntentIds: string[];
  questionForLLM: string;
  questionForDisplay: string;
  detectedIntent: string;
  sessionStateSummary: string;
  confidence: number;
  decisionMetadata: Prisma.InputJsonObject;
  fromTranscriptChunkId?: string;
  toTranscriptChunkId?: string;
  redisSummary: string;
};

type SegmenterParams = {
  sessionId: string;
  rawTranscript: string;
  metadata?: AIAnswerLiveContextMetadata;
  ai: any;
  model?: string;
  provider?: any;
};

type NormalizedSegmenterJson = {
  segments: unknown[];
  intents: unknown[];
  latestIntentId: string | null;
  relatedPendingIntentIds: string[];
  conversationStateSummary: string;
  confidence: number;
};

const SEGMENTER_TIME_WINDOW_MS = 180_000;
const SEGMENTER_MAX_CHUNKS = 60;
const REDIS_TTL_SECONDS = 60 * 60 * 3;
const REDIS_TRANSCRIPT_LIMIT = 20;
const REDIS_CHECKPOINT_LIMIT = 5;

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return normalizeSpaces(text).slice(0, max);
}

function stripSpeakerLabels(text: string): string {
  return normalizeSpaces(text)
    .replace(/\[(?:user|candidate|interviewer|assistant|system)\]\s*:\s*/gi, "")
    .replace(/(^|[.!?]\s+)(?:candidate|user|interviewer|assistant|system)\s*:\s*/gi, "$1")
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim();
}

function cleanGeneratedQuestion(text: string): string {
  const cleaned = stripSpeakerLabels(text)
    .replace(/\b(candidate|user)\s*:\s*(?=\1\s*:)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  const repeatedPrefixMatch = cleaned.match(/^(.{4,80}?[?.!])\s+\1\s+/i);
  if (repeatedPrefixMatch) {
    return cleaned.replace(repeatedPrefixMatch[0], `${repeatedPrefixMatch[1]} `).trim();
  }
  return cleaned;
}

function memoryKey(sessionId: string): string {
  return `session:${sessionId}:ai-segmenter-memory`;
}

function stableIntentId(sessionId: string, text: string, index: number): string {
  const digest = crypto
    .createHash("sha1")
    .update(`${sessionId}:${normalizeSpaces(text).toLowerCase()}:${index}`)
    .digest("hex")
    .slice(0, 12);
  return `intent_${digest}`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function mapSpeakerType(value: unknown): SegmenterSpeaker {
  if (value === "interviewer" || value === SpeakerType.INTERVIEWER || value === "Interviewer") {
    return "interviewer";
  }
  if (value === "candidate" || value === SpeakerType.CANDIDATE || value === "User") {
    return "candidate";
  }
  if (value === "assistant" || value === "AI_ASSISTANT") return "assistant";
  if (value === "system") return "system";
  return "unknown";
}

function transcriptKey(chunk: SegmenterTranscriptChunk): string {
  return [
    chunk.transcriptChunkId || chunk.messageId || chunk.id,
    chunk.speaker,
    chunk.timestamp,
    normalizeSpaces(chunk.text).toLowerCase(),
  ].join(":");
}

function parseJsonObject(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12);
}

function normalizeMemory(raw: string | null): SessionSegmenterMemory {
  if (!raw) {
    return {
      transcriptChunks: [],
      answerCheckpoints: [],
      sessionStateSummary: "",
      activeUnresolvedIntentIds: [],
      resolvedIntentIds: [],
      updatedAt: new Date(0).toISOString(),
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SessionSegmenterMemory>;
    return {
      transcriptChunks: Array.isArray(parsed.transcriptChunks) ? parsed.transcriptChunks : [],
      answerCheckpoints: Array.isArray(parsed.answerCheckpoints) ? parsed.answerCheckpoints : [],
      sessionStateSummary: typeof parsed.sessionStateSummary === "string" ? parsed.sessionStateSummary : "",
      activeUnresolvedIntentIds: Array.isArray(parsed.activeUnresolvedIntentIds)
        ? parsed.activeUnresolvedIntentIds.map(String)
        : [],
      resolvedIntentIds: Array.isArray(parsed.resolvedIntentIds)
        ? parsed.resolvedIntentIds.map(String)
        : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch (error) {
    console.warn("[ai-segmenter] failed parsing redis memory", { error });
    return {
      transcriptChunks: [],
      answerCheckpoints: [],
      sessionStateSummary: "",
      activeUnresolvedIntentIds: [],
      resolvedIntentIds: [],
      updatedAt: new Date(0).toISOString(),
    };
  }
}

async function readMemory(sessionId: string): Promise<SessionSegmenterMemory> {
  const raw = await redisConnection.get(memoryKey(sessionId)).catch((error) => {
    console.warn("[ai-segmenter] redis memory read failed", { sessionId, error });
    return null;
  });
  return normalizeMemory(raw);
}

async function writeMemory(sessionId: string, memory: SessionSegmenterMemory): Promise<void> {
  await redisConnection
    .set(memoryKey(sessionId), JSON.stringify(memory), "EX", REDIS_TTL_SECONDS)
    .catch((error) => {
      console.warn("[ai-segmenter] redis memory write failed", { sessionId, error });
    });
}

function payloadChunks(metadata?: AIAnswerLiveContextMetadata): SegmenterTranscriptChunk[] {
  const speakerEntries = metadata?.speakerSeparatedTranscript || [];
  return speakerEntries
    .map((entry, index): SegmenterTranscriptChunk | null => {
      const text = normalizeSpaces(entry.content || "");
      if (!text) return null;
      const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : Date.now() + index;
      return {
        id: `payload:${timestamp}:${index}`,
        speaker: mapSpeakerType(entry.speakerType),
        text,
        timestamp,
        source: "payload" as const,
      };
    })
    .filter((entry): entry is SegmenterTranscriptChunk => entry !== null);
}

async function dbChunksSinceCheckpoint(
  sessionId: string,
): Promise<{
  chunks: SegmenterTranscriptChunk[];
  checkpointResolvedIds: string[];
  latestCheckpoint?: {
    id: string;
    createdAt: Date;
    sessionStateSummary?: string | null;
  };
}> {
  const latestCheckpoint = await prisma.answerGenerationSnapshot.findFirst({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      resolvedIntentIds: true,
      sessionStateSummary: true,
    },
  });
  const cutoff = new Date(Date.now() - SEGMENTER_TIME_WINDOW_MS);
  const chunks = await prisma.transcriptChunk.findMany({
    where: {
      sessionId,
      OR: latestCheckpoint
        ? [{ createdAt: { gt: latestCheckpoint.createdAt } }, { createdAt: { gte: cutoff } }]
        : [{ createdAt: { gte: cutoff } }],
    },
    orderBy: { createdAt: "asc" },
    take: 120,
    select: {
      id: true,
      questionId: true,
      content: true,
      question: true,
      aiAnswer: true,
      speakerType: true,
      startTime: true,
      createdAt: true,
    },
  });

  return {
    latestCheckpoint: latestCheckpoint
      ? {
          id: latestCheckpoint.id,
          createdAt: latestCheckpoint.createdAt,
          sessionStateSummary: latestCheckpoint.sessionStateSummary,
        }
      : undefined,
    checkpointResolvedIds: latestCheckpoint?.resolvedIntentIds || [],
    chunks: chunks.map((chunk) => {
      const text = normalizeSpaces(
        chunk.question || chunk.content.replace(/\*\*QUESTION:\*\*|\*\*ANSWER:\*\*/g, " "),
      );
      return {
        id: `db:${chunk.id}`,
        transcriptChunkId: chunk.id,
        messageId: chunk.questionId || undefined,
        speaker: mapSpeakerType(chunk.speakerType),
        text,
        timestamp:
          typeof chunk.startTime === "number"
            ? chunk.startTime
            : chunk.createdAt.getTime(),
        source: "db" as const,
      };
    }),
  };
}

function mergeBoundedChunks(input: {
  dbChunks: SegmenterTranscriptChunk[];
  payloadChunks: SegmenterTranscriptChunk[];
  redisChunks: SegmenterTranscriptChunk[];
}): SegmenterTranscriptChunk[] {
  const byKey = new Map<string, SegmenterTranscriptChunk>();
  for (const chunk of [
    ...input.redisChunks.map((entry) => ({ ...entry, source: "redis" as const })),
    ...input.dbChunks,
    ...input.payloadChunks,
  ]) {
    const text = normalizeSpaces(chunk.text);
    if (!text) continue;
    byKey.set(transcriptKey({ ...chunk, text }), { ...chunk, text });
  }

  return [...byKey.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-SEGMENTER_MAX_CHUNKS);
}

function normalizeSegmenterJson(raw: unknown): NormalizedSegmenterJson {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    segments: Array.isArray(data.segments) ? data.segments : [],
    intents: Array.isArray(data.intents) ? data.intents : [],
    latestIntentId: typeof data.latestIntentId === "string" ? data.latestIntentId : null,
    relatedPendingIntentIds: coerceStringArray(data.relatedPendingIntentIds),
    conversationStateSummary: clip(asString(data.conversationStateSummary), 1200),
    confidence: clampConfidence(asNumber(data.confidence)),
  };
}

function normalizeIntent(input: {
  raw: unknown;
  sessionId: string;
  index: number;
  resolvedIds: Set<string>;
  hasInterviewerChunks: boolean;
}): SegmenterIntent | null {
  const value = input.raw && typeof input.raw === "object" ? (input.raw as Record<string, unknown>) : {};
  const question = cleanGeneratedQuestion(clip(
    asString(value.question) ||
      asString(value.questionGenerated) ||
      asString(value.intentText),
    1000,
  ));
  if (!question) return null;

  const id = stableIntentId(input.sessionId, question, input.index);
  if (input.resolvedIds.has(id)) return null;

  const speakerOrigin = mapSpeakerType(value.speakerOrigin || value.speaker);
  const interviewerOriginated =
    speakerOrigin === "interviewer" ||
    (!input.hasInterviewerChunks && speakerOrigin !== "assistant" && speakerOrigin !== "system");
  if (!interviewerOriginated) return null;

  const statusRaw = asString(value.status).toLowerCase();
  const status: SegmenterIntent["status"] =
    statusRaw === "answered" || statusRaw === "ignored" ? statusRaw : "unanswered";
  const relevanceRaw = asString(value.relevance).toLowerCase();
  const relevance: SegmenterIntent["relevance"] =
    relevanceRaw === "stale" || relevanceRaw === "filler"
      ? relevanceRaw
      : relevanceRaw === "related"
        ? "related"
        : "active";

  if (status !== "unanswered") return null;
  if (relevance !== "active" && relevance !== "related") return null;

  return {
    id,
    question,
    speakerOrigin: speakerOrigin === "unknown" && !input.hasInterviewerChunks ? "interviewer" : speakerOrigin,
    status,
    relevance,
    confidence: clampConfidence(asNumber(value.confidence) || 0.5),
    transcriptChunkIds: coerceStringArray(value.transcriptChunkIds),
    relatedIntentIds: coerceStringArray(value.relatedIntentIds),
    reason: clip(asString(value.reason), 240) || "segmenter_intent",
  };
}

function buildQuestionForLLM(intents: SegmenterIntent[]): string {
  if (intents.length <= 1) {
    return cleanGeneratedQuestion(intents[0]?.question || "");
  }

  return [
    ...intents.map((intent, index) => `${index + 1}. [${intent.id}] ${intent.question}`),
  ].join("\n");
}

function fallbackIntent(input: {
  sessionId: string;
  chunks: SegmenterTranscriptChunk[];
  rawTranscript: string;
  resolvedIds: Set<string>;
  currentQuestionHint?: string;
  metadata?: AIAnswerLiveContextMetadata;
}): SegmenterIntent {
  const currentQuestionHint = cleanGeneratedQuestion(input.currentQuestionHint || "");
  const preferredChunks = input.chunks.some((chunk) => chunk.speaker === "interviewer")
    ? input.chunks.filter((chunk) => chunk.speaker === "interviewer")
    : input.chunks;
  const rawContext = preferredChunks.map((chunk) => chunk.text).join("\n");
  const reconstruction = reconstructFallbackQuestion({
    rawTranscript: rawContext || input.rawTranscript,
    currentQuestionHint,
    activeQuestionHint: input.metadata?.activeQuestionDetection?.activeQuestion,
    recentTranscriptWindow: input.metadata?.recentTranscriptWindow,
    metadata: input.metadata,
  });
  const question = clip(
    cleanGeneratedQuestion(reconstruction.question),
    900,
  );
  let id = stableIntentId(input.sessionId, question, 0);
  if (input.resolvedIds.has(id)) {
    id = `${id}_${Date.now().toString(36)}`;
  }
  return {
    id,
    question,
    speakerOrigin: "interviewer",
    status: "unanswered",
    relevance: "active",
    confidence: reconstruction.confidence,
    transcriptChunkIds: input.chunks.map((chunk) => chunk.transcriptChunkId || chunk.id).filter(Boolean),
    relatedIntentIds: [],
    reason: reconstruction.corrections.length > 0
      ? `segmenter_fallback_${reconstruction.corrections.join("_")}`
      : "segmenter_fallback_backend_reconstruction",
  };
}

function buildDecisionFromSegmenter(result: AIAnswerSegmenterResult): AISessionDecision {
  const topic = deriveTopicFromAnyText(result.questionForDisplay);
  const isFollowUp = /follow|continue|previous|that|this|explain more|why/i.test(result.questionForDisplay);
  return {
    intent: result.detectedIntent as AISessionDecision["intent"],
    isFollowUp,
    targetAnswerId: null,
    requiresPreviousCode: /\b(code|query|debug|optimi[sz]e|fix)\b/i.test(result.questionForDisplay),
    answerMode: "auto",
    topic: topic || "general",
    confidence: result.confidence,
    reason: result.source === "ai" ? "ai_segmenter" : "segmenter_fallback_answer_anyway",
    contextToUse: "recent_transcript",
  };
}

function intentFromSegmenterQuestion(question: string): AISessionDecision["intent"] {
  if (/\b(introduce|experience|background|project|tech stack|role|responsibilit)/i.test(question)) {
    return "EXPERIENCE_QUESTION";
  }
  if (/\b(debug|fix|bug|error)\b/i.test(question)) return "DEBUG_CODE";
  if (/\b(optimi[sz]e|slow|performance)\b/i.test(question)) return "OPTIMIZE_CODE";
  if (/\b(system design|architecture|scale|scalab)\b/i.test(question)) return "SCENARIO_QUESTION";
  if (/\b(continue|previous|that|this|explain more|why)\b/i.test(question)) return "FOLLOW_UP";
  return "NEW_QUESTION";
}

async function runSegmenterAI(input: {
  params: SegmenterParams;
  chunks: SegmenterTranscriptChunk[];
  memory: SessionSegmenterMemory;
  resolvedIds: Set<string>;
}): Promise<NormalizedSegmenterJson> {
  const system = [
    "You are ScribeShade's live interview conversation segmenter.",
    "Return strict JSON only. No markdown.",
    "Group fragmented interviewer speech into coherent conversation segments and active intents.",
    "Only produce intents that are unanswered, interviewer-originated, and still relevant.",
    "Do not output filler, candidate self-talk, greetings, or already answered intents.",
    "If fragmented phrases form one progressive task, group them as one related intent chain.",
  ].join("\n");
  const user = JSON.stringify({
    outputContract: {
      segments: [
        {
          id: "segment id",
          transcriptChunkIds: ["chunk ids"],
          topic: "short topic",
          speakerOrigin: "interviewer | candidate | unknown",
          summary: "short segment summary",
        },
      ],
      intents: [
        {
          id: "stable intent id if known",
          question: "best reconstructed interviewer ask",
          speakerOrigin: "interviewer | candidate | unknown",
          status: "unanswered | answered | ignored",
          relevance: "active | related | stale | filler",
          confidence: "0..1",
          transcriptChunkIds: ["chunk ids"],
          relatedIntentIds: ["ids"],
          reason: "short reason",
        },
      ],
      latestIntentId: "id or null",
      relatedPendingIntentIds: ["ids"],
      conversationStateSummary: "compact interview state",
      confidence: "0..1",
    },
    boundedTranscriptPolicy: "Use since last checkpoint + last 2-3 minutes + memory summary only.",
    transcriptChunks: input.chunks.map((chunk) => ({
      id: chunk.transcriptChunkId || chunk.id,
      speaker: chunk.speaker,
      text: chunk.text,
      timestamp: chunk.timestamp,
      source: chunk.source,
    })),
    redisSummary: input.memory.sessionStateSummary,
    recentAnswerCheckpoints: input.memory.answerCheckpoints.slice(-REDIS_CHECKPOINT_LIMIT),
    alreadyResolvedIntentIds: [...input.resolvedIds],
    legacyCurrentQuestionHint: input.params.metadata?.activeQuestionDetection?.cleanedQuestion || "",
  });
  const segmenterModel =
    process.env.AI_SEGMENTER_MODEL ||
    process.env.AI_SESSION_DECISION_MODEL ||
    "openai/gpt-4o-mini";
  const timeoutMs = Number(process.env.AI_SEGMENTER_TIMEOUT_MS || 1800);
  const result = input.params.ai.callModel({
    model: segmenterModel,
    maxOutputTokens: 900,
    provider: input.params.provider,
    store: false,
    sessionId: input.params.sessionId,
    input: [
      { role: "system", type: "message", content: system },
      { role: "user", type: "message", content: user },
    ],
    text: {
      format: { type: "json_object" },
    },
  });
  const content = await Promise.race([
    result.getText(),
    new Promise<string>((_resolve, reject) =>
      setTimeout(() => reject(new Error("ai_segmenter_timeout")), timeoutMs),
    ),
  ]);
  return normalizeSegmenterJson(parseJsonObject(content));
}

export async function appendSegmenterTranscriptMemory(input: {
  sessionId: string;
  chunk: SegmenterTranscriptChunk;
}): Promise<void> {
  const memory = await readMemory(input.sessionId);
  const transcriptChunks = [...memory.transcriptChunks, input.chunk]
    .filter((chunk) => normalizeSpaces(chunk.text))
    .slice(-REDIS_TRANSCRIPT_LIMIT);
  await writeMemory(input.sessionId, {
    ...memory,
    transcriptChunks,
    updatedAt: new Date().toISOString(),
  });
}

export async function writeSegmenterAnswerMemory(input: {
  sessionId: string;
  snapshotId: string;
  result: AIAnswerSegmenterResult;
  answer: string;
}): Promise<void> {
  const memory = await readMemory(input.sessionId);
  const resolvedIntentIds = [
    ...new Set([...memory.resolvedIntentIds, ...input.result.resolvedIntentIds]),
  ].slice(-100);
  const checkpoint: SegmenterCheckpointMemory = {
    snapshotId: input.snapshotId,
    resolvedIntentIds: input.result.resolvedIntentIds,
    questionGenerated: input.result.questionForDisplay,
    detectedIntent: input.result.detectedIntent,
    sessionStateSummary: input.result.sessionStateSummary || clip(input.answer, 800),
    confidence: input.result.confidence,
    createdAt: new Date().toISOString(),
  };
  const activeUnresolvedIntentIds = memory.activeUnresolvedIntentIds.filter(
    (id) => !input.result.resolvedIntentIds.includes(id),
  );
  await writeMemory(input.sessionId, {
    ...memory,
    answerCheckpoints: [...memory.answerCheckpoints, checkpoint].slice(-REDIS_CHECKPOINT_LIMIT),
    sessionStateSummary: checkpoint.sessionStateSummary,
    activeUnresolvedIntentIds,
    resolvedIntentIds,
    updatedAt: new Date().toISOString(),
  });
}

export function buildSegmenterContextBlock(result: AIAnswerSegmenterResult): string {
  return [
    "AI SEGMENTER DECISION:",
    `source: ${result.source}`,
    `detectedIntent: ${result.detectedIntent}`,
    `confidence: ${result.confidence.toFixed(2)}`,
    `latestIntentId: ${result.latestIntentId || "none"}`,
    `resolvedIntentIds: ${result.resolvedIntentIds.join(", ") || "none"}`,
    `sessionStateSummary: ${result.sessionStateSummary || "none"}`,
    "",
    "ACTIVE INTENTS TO ANSWER:",
    ...result.intentsToAnswer.map((intent, index) =>
      `${index + 1}. [${intent.id}] ${intent.question} (${intent.relevance}, confidence=${intent.confidence.toFixed(2)})`,
    ),
    "",
    "BOUNDED RAW TRANSCRIPT USED BY SEGMENTER:",
    ...result.boundedTranscript.map((chunk) => `- ${chunk.speaker}: ${chunk.text}`),
  ].join("\n");
}

export async function segmentAIAnswerRequest(
  params: SegmenterParams,
): Promise<AIAnswerSegmenterResult> {
  const [memory, dbResult] = await Promise.all([
    readMemory(params.sessionId),
    dbChunksSinceCheckpoint(params.sessionId),
  ]);
  const boundedTranscript = mergeBoundedChunks({
    dbChunks: dbResult.chunks,
    payloadChunks: payloadChunks(params.metadata),
    redisChunks: memory.transcriptChunks,
  });
  const resolvedIds = new Set<string>([
    ...memory.resolvedIntentIds,
    ...dbResult.checkpointResolvedIds,
  ]);
  const rawContext =
    boundedTranscript.map((chunk) => `${chunk.speaker}: ${chunk.text}`).join("\n") ||
    normalizeSpaces(params.rawTranscript);
  const hasInterviewerChunks = boundedTranscript.some((chunk) => chunk.speaker === "interviewer");

  let source: SegmenterSource = "ai";
  let json: NormalizedSegmenterJson;
  try {
    json = await runSegmenterAI({ params, chunks: boundedTranscript, memory, resolvedIds });
  } catch (error) {
    console.warn("[ai-segmenter] segmenter failed, answering from fallback", {
      sessionId: params.sessionId,
      error,
    });
    source = "fallback";
    json = {
      segments: [],
      intents: [],
      latestIntentId: null,
      relatedPendingIntentIds: [],
      conversationStateSummary:
        memory.sessionStateSummary || dbResult.latestCheckpoint?.sessionStateSummary || "",
      confidence: 0.25,
    };
  }

  const normalizedIntents = json.intents
    .map((raw, index) =>
      normalizeIntent({
        raw,
        sessionId: params.sessionId,
        index,
        resolvedIds,
        hasInterviewerChunks,
      }),
    )
    .filter((intent): intent is SegmenterIntent => Boolean(intent));
  const selectedIntentIds = new Set<string>([
    ...(json.latestIntentId ? [json.latestIntentId] : []),
    ...json.relatedPendingIntentIds,
  ]);
  let intentsToAnswer = normalizedIntents
    .filter((intent) => selectedIntentIds.size === 0 || selectedIntentIds.has(intent.id))
    .slice(-4);
  if (intentsToAnswer.length === 0 && normalizedIntents.length > 0) {
    intentsToAnswer = normalizedIntents.slice(-4);
  }

  if (intentsToAnswer.length === 0) {
    source = "fallback";
    intentsToAnswer = [
      fallbackIntent({
        sessionId: params.sessionId,
        chunks: boundedTranscript,
        rawTranscript: params.rawTranscript,
        resolvedIds,
        currentQuestionHint:
          params.metadata?.activeQuestionDetection?.cleanedQuestion ||
          params.metadata?.activeQuestionDetection?.activeQuestion ||
          "",
        metadata: params.metadata,
      }),
    ];
  }

  const latestIntentId =
    json.latestIntentId && intentsToAnswer.some((intent) => intent.id === json.latestIntentId)
      ? json.latestIntentId
      : intentsToAnswer[intentsToAnswer.length - 1]?.id || null;
  const relatedPendingIntentIds = intentsToAnswer
    .filter((intent) => intent.id !== latestIntentId)
    .map((intent) => intent.id);
  const questionForDisplay = intentsToAnswer.map((intent) => cleanGeneratedQuestion(intent.question) || intent.question).join(" | ");
  const confidence = clampConfidence(
    json.confidence || Math.max(...intentsToAnswer.map((intent) => intent.confidence), 0.25),
  );
  const detectedIntent = intentFromSegmenterQuestion(questionForDisplay);
  const fromTranscriptChunkId = boundedTranscript.find((chunk) => chunk.transcriptChunkId)?.transcriptChunkId;
  const toTranscriptChunkId = [...boundedTranscript].reverse().find((chunk) => chunk.transcriptChunkId)?.transcriptChunkId;
  const result: AIAnswerSegmenterResult = {
    source,
    boundedTranscript,
    intentsToAnswer,
    latestIntentId,
    relatedPendingIntentIds,
    resolvedIntentIds: intentsToAnswer.map((intent) => intent.id),
    questionForLLM: buildQuestionForLLM(intentsToAnswer),
    questionForDisplay,
    detectedIntent,
    sessionStateSummary:
      json.conversationStateSummary ||
      memory.sessionStateSummary ||
      dbResult.latestCheckpoint?.sessionStateSummary ||
      clip(rawContext, 1000),
    confidence,
    fromTranscriptChunkId,
    toTranscriptChunkId,
    redisSummary: memory.sessionStateSummary,
    decisionMetadata: {
      source,
      segments: json.segments as Prisma.InputJsonValue,
      latestIntentId,
      relatedPendingIntentIds,
      boundedTranscriptCount: boundedTranscript.length,
      safeguards: {
        boundedWindowMs: SEGMENTER_TIME_WINDOW_MS,
        maxChunks: SEGMENTER_MAX_CHUNKS,
        answeredOnlyUnresolvedInterviewerRelevant: true,
        fallbackAlwaysStreams: true,
      },
    },
  };

  const nextActiveUnresolvedIntentIds = [
    ...new Set([
      ...memory.activeUnresolvedIntentIds,
      ...normalizedIntents.map((intent) => intent.id),
    ]),
  ].filter((id) => !result.resolvedIntentIds.includes(id));
  await writeMemory(params.sessionId, {
    ...memory,
    transcriptChunks: boundedTranscript.slice(-REDIS_TRANSCRIPT_LIMIT),
    activeUnresolvedIntentIds: nextActiveUnresolvedIntentIds,
    sessionStateSummary: result.sessionStateSummary,
    updatedAt: new Date().toISOString(),
  });

  return {
    ...result,
    decisionMetadata: {
      ...result.decisionMetadata,
      aiDecision: buildDecisionFromSegmenter(result) as unknown as Prisma.InputJsonValue,
    },
  };
}

export function buildAISessionDecisionFromSegmenter(
  result: AIAnswerSegmenterResult,
): AISessionDecision {
  return buildDecisionFromSegmenter(result);
}
