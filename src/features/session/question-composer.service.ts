import crypto from "crypto";
import { SpeakerType } from "@prisma/client";
import { prisma } from "../../shared/lib/prisma";
import { redisConnection } from "../jobs/queue";
import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";
import { deriveTopicFromAnyText } from "./answer-quality";

export type IntentKind =
  | "intro"
  | "intro_projects"
  | "project_deep_dive"
  | "coding"
  | "code_followup"
  | "system_design"
  | "behavioral"
  | "scenario"
  | "conceptual";

export type IntentStatus = "unanswered" | "answered" | "ignored";

export type FollowupType =
  | "clarification"
  | "code_explanation"
  | "testing"
  | "optimization"
  | "scenario_extension"
  | "behavioral_probe";

export type AnswerClickMode =
  | "answer_latest_unanswered"
  | "answer_selected_intent"
  | "reanswer_previous"
  | "regenerate_answer"
  | "answer_followup";

export type IntentLedgerEntry = {
  id: string;
  question: string;
  normalizedQuestion: string;
  intent: IntentKind;
  status: IntentStatus;
  evidenceChunkIds: string[];
  transcriptExcerpt: string;
  topic: string;
  parentIntentId?: string;
  followupType?: FollowupType;
  answerId?: string;
  createdAt: string;
  answeredAt?: string;
};

export type IntentLedger = {
  intents: IntentLedgerEntry[];
  activeIntentId?: string;
};

export type AnswerLedger = {
  answers: AnswerLedgerEntry[];
};

export type AnswerLedgerEntry = {
  answerId: string;
  intentId: string;
  question: string;
  answerSummary: string;
  keyClaims: string[];
  codeBlocks?: Array<{
    language: string;
    purpose: string;
    summary: string;
    codeHash: string;
  }>;
  topic: string;
  createdAt: string;
};

export type ActiveAnswerPlan = {
  intentId: string;
  questions: string[];
  intent: IntentKind;
  confidence: number;
  evidenceChunkIds: string[];
  transcriptExcerpt: string;
  isAnswerable: boolean;
  fromTranscriptChunkId: string;
  toTranscriptChunkId: string;
  lastTranscriptTimestamp: string;
  chunkHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  answeredQuestionHash?: string;
};

export type ComposerTranscriptChunk = {
  id: string;
  transcriptChunkId?: string;
  messageId?: string;
  speaker: "interviewer" | "candidate" | "assistant" | "system" | "unknown";
  text: string;
  timestamp: number;
  createdAt: string;
  source: "db" | "payload";
};

export type ComposerSelection = {
  source:
    | "active_plan"
    | "composer"
    | "manual"
    | "selected_intent"
    | "reanswer"
    | "degraded_hint"
    | "evidence_batch"
    | "none";
  questions: string[];
  intent: IntentKind;
  confidence: number;
  transcriptExcerpt: string;
  selectedIntent?: IntentLedgerEntry;
  intentLedger: IntentLedger;
  answerLedger: AnswerLedger;
  activePlan?: ActiveAnswerPlan;
};

type ComposeRuntimeInput = {
  sessionId: string;
  metadata?: AIAnswerLiveContextMetadata;
  currentQuestionHint?: string;
  ai: any;
  model?: string;
  provider?: any;
  timeoutMs: number;
};

const ACTIVE_PLAN_CONFIDENCE_THRESHOLD = 0.65;
const ACTIVE_PLAN_TTL_SECONDS = 90;
const LEDGER_TTL_SECONDS = 60 * 60 * 8;
const DEBOUNCE_TTL_SECONDS = 2;
const LOCK_TTL_MS = 5000;
const DEBOUNCE_MS = 400;
const PRECOMPOSE_TIMEOUT_MS = 3000;
const CLICK_COMPOSER_TIMEOUT_MS = 1200;
const REGENERATE_COMPOSER_TIMEOUT_MS = 1200;
const MAX_LEDGER_INTENTS = 80;
const MAX_LEDGER_ANSWERS = 40;
const MAX_EVIDENCE_CHUNKS = 60;
const MIN_STANDALONE_QUESTION_CHARS = 20;
const MIN_STANDALONE_QUESTION_WORDS = 4;
const EVIDENCE_DEDUPE_WINDOW_MS = 2000;

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function activeAnswerPlanKey(sessionId: string): string {
  return `session:${sessionId}:active-answer-plan`;
}

function intentLedgerKey(sessionId: string): string {
  return `session:${sessionId}:intent-ledger`;
}

function answerLedgerKey(sessionId: string): string {
  return `session:${sessionId}:answer-ledger`;
}

function composerLockKey(sessionId: string): string {
  return `session:${sessionId}:question-composer-lock`;
}

function composerDebounceKey(sessionId: string): string {
  return `session:${sessionId}:question-composer-debounce`;
}

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function normalizeQuestion(text: string): string {
  return normalizeSpaces(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, maxChars: number): string {
  const normalized = normalizeSpaces(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 16)).trim()}...`;
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function stableIntentId(sessionId: string, question: string): string {
  return `intent_${sha1(`${sessionId}:${normalizeQuestion(question)}`).slice(0, 16)}`;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function mapSpeaker(value: unknown): ComposerTranscriptChunk["speaker"] {
  if (value === SpeakerType.INTERVIEWER || value === "interviewer" || value === "Interviewer") return "interviewer";
  if (value === SpeakerType.CANDIDATE || value === "candidate" || value === "User" || value === "user") return "candidate";
  if (value === SpeakerType.ASSISTANT || value === "assistant" || value === "AI_ASSISTANT") return "assistant";
  if (value === SpeakerType.SYSTEM || value === "system") return "system";
  return "unknown";
}

function isPureFiller(text: string): boolean {
  const cleaned = normalizeQuestion(text);
  if (!cleaned) return true;
  return /^(hi|hello|hey|okay|ok|yeah|yes|no|right|fine|hmm|um|uh|thanks|thank you|lets start|let s start|can you hear me|am i audible)$/.test(cleaned);
}

function isQuestionLikeEvidence(text: string): boolean {
  const cleaned = normalizeSpaces(text);
  if (!cleaned || isPureFiller(cleaned)) return false;
  if (cleaned.includes("?")) return true;
  return /\b(what|why|how|when|where|which|who|can|could|would|should|is|are|do|does|did|explain|define|describe|tell me|introduce|walk me|write|implement|design|debug|optimi[sz]e|test|edge cases?|scenario|project|experience)\b/i.test(cleaned);
}

function wordCount(text: string): number {
  return normalizeSpaces(text).split(/\s+/).filter(Boolean).length;
}

function isTinyQuestionFragment(text: string): boolean {
  const cleaned = sanitizeQuestion(text);
  if (!cleaned) return true;
  if (cleaned.length < MIN_STANDALONE_QUESTION_CHARS) return true;
  return wordCount(cleaned) < MIN_STANDALONE_QUESTION_WORDS;
}

function isCleanCompleteQuestionHint(text: string): boolean {
  const cleaned = sanitizeQuestion(text);
  return isQuestionLikeEvidence(cleaned) && !isTinyQuestionFragment(cleaned);
}

function sanitizeQuestion(text: string): string {
  return normalizeSpaces(text)
    .replace(/\[(?:user|candidate|interviewer|assistant|system)\]\s*:\s*/gi, "")
    .replace(/(^|[.!?]\s+)(?:candidate|user|interviewer|assistant|system)\s*:\s*/gi, "$1")
    .trim();
}

function inferIntent(question: string): IntentKind {
  const text = question.toLowerCase();
  if (/\b(test|edge case|unit test|integration test)\b/.test(text)) return "code_followup";
  if (/\b(debug|fix|bug|code|function|algorithm|query|sql|implement|write)\b/.test(text)) return "coding";
  if (/\b(system design|architecture|scale|distributed|scalable)\b/.test(text)) return "system_design";
  if (/\b(scenario|suppose|imagine|what would you do|case study)\b/.test(text)) return "scenario";
  if (/\b(project|projects|built|worked on|tech stack|deep dive)\b/.test(text)) {
    return /\b(introduce|background|yourself)\b/.test(text) ? "intro_projects" : "project_deep_dive";
  }
  if (/\b(introduce|yourself|background)\b/.test(text)) return "intro";
  if (/\b(behavior|conflict|challenge|leadership|failure|strength|weakness)\b/.test(text)) return "behavioral";
  return "conceptual";
}

function inferFollowupType(question: string): FollowupType | undefined {
  const text = question.toLowerCase();
  if (/\b(test|edge case)\b/.test(text)) return "testing";
  if (/\b(optimi[sz]e|performance|faster)\b/.test(text)) return "optimization";
  if (/\b(code|query|function|explain that)\b/.test(text)) return "code_explanation";
  if (/\b(scenario|what if|suppose)\b/.test(text)) return "scenario_extension";
  if (/\b(why|clarify|more|detail|that|this|it)\b/.test(text)) return "clarification";
  return undefined;
}

function latestAnsweredIntent(ledger: IntentLedger): IntentLedgerEntry | undefined {
  return [...ledger.intents].reverse().find((intent) => intent.status === "answered");
}

function isFollowupQuestion(question: string): boolean {
  return /\b(that|this|it|there|previous|above|you mentioned|why|how would you test|edge cases?|optimi[sz]e|explain the code|approach)\b/i.test(question);
}

function parseJsonObject(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20);
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await redisConnection.get(key).catch((error) => {
    console.warn("[question-composer] redis read failed", { key, error });
    return null;
  });
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn("[question-composer] redis json parse failed", { key, error });
    return fallback;
  }
}

async function writeJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await redisConnection.set(key, JSON.stringify(value), "EX", ttlSeconds).catch((error) => {
    console.warn("[question-composer] redis write failed", { key, error });
  });
}

export async function readIntentLedger(sessionId: string): Promise<IntentLedger> {
  const ledger = await readJson<IntentLedger>(intentLedgerKey(sessionId), { intents: [] });
  return {
    intents: Array.isArray(ledger.intents) ? ledger.intents : [],
    ...(ledger.activeIntentId ? { activeIntentId: ledger.activeIntentId } : {}),
  };
}

export async function readAnswerLedger(sessionId: string): Promise<AnswerLedger> {
  const ledger = await readJson<AnswerLedger>(answerLedgerKey(sessionId), { answers: [] });
  return { answers: Array.isArray(ledger.answers) ? ledger.answers : [] };
}

async function writeIntentLedger(sessionId: string, ledger: IntentLedger): Promise<void> {
  await writeJson(intentLedgerKey(sessionId), {
    intents: ledger.intents.slice(-MAX_LEDGER_INTENTS),
    ...(ledger.activeIntentId ? { activeIntentId: ledger.activeIntentId } : {}),
  }, LEDGER_TTL_SECONDS);
}

async function writeAnswerLedger(sessionId: string, ledger: AnswerLedger): Promise<void> {
  await writeJson(answerLedgerKey(sessionId), {
    answers: ledger.answers.slice(-MAX_LEDGER_ANSWERS),
  }, LEDGER_TTL_SECONDS);
}

export async function readActiveAnswerPlan(sessionId: string): Promise<ActiveAnswerPlan | null> {
  return readJson<ActiveAnswerPlan | null>(activeAnswerPlanKey(sessionId), null);
}

async function writeActiveAnswerPlan(sessionId: string, plan: ActiveAnswerPlan): Promise<void> {
  await writeJson(activeAnswerPlanKey(sessionId), plan, ACTIVE_PLAN_TTL_SECONDS);
}

function chunkIdentity(chunk: ComposerTranscriptChunk): string {
  return chunk.transcriptChunkId || chunk.messageId || chunk.id;
}

function buildChunkHash(chunks: ComposerTranscriptChunk[]): string {
  return sha1(chunks.map((chunk) => [
    chunkIdentity(chunk),
    chunk.speaker,
    chunk.timestamp,
    normalizeQuestion(chunk.text),
  ].join(":")).join("|"));
}

async function loadDbEvidence(sessionId: string): Promise<ComposerTranscriptChunk[]> {
  const chunks = await prisma.transcriptChunk.findMany({
    where: { sessionId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_EVIDENCE_CHUNKS,
    select: {
      id: true,
      questionId: true,
      question: true,
      content: true,
      aiAnswer: true,
      speakerType: true,
      startTime: true,
      createdAt: true,
    },
  });

  return chunks.map((chunk) => ({
    id: `db:${chunk.id}`,
    transcriptChunkId: chunk.id,
    messageId: chunk.questionId || undefined,
    speaker: mapSpeaker(chunk.speakerType),
    text: normalizeSpaces(chunk.question || chunk.content || chunk.aiAnswer || ""),
    timestamp: typeof chunk.startTime === "number" ? chunk.startTime : chunk.createdAt.getTime(),
    createdAt: chunk.createdAt.toISOString(),
    source: "db" as const,
  }));
}

function loadPayloadEvidence(metadata: AIAnswerLiveContextMetadata | undefined): ComposerTranscriptChunk[] {
  return (metadata?.speakerSeparatedTranscript || []).map((entry, index) => {
    const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : Date.now() + index;
    return {
      id: `payload:${timestamp}:${index}`,
      speaker: mapSpeaker(entry.speakerType),
      text: normalizeSpaces(entry.content || ""),
      timestamp,
      createdAt: new Date(timestamp).toISOString(),
      source: "payload" as const,
    };
  });
}

function mergeEvidence(input: {
  dbChunks: ComposerTranscriptChunk[];
  payloadChunks: ComposerTranscriptChunk[];
}): ComposerTranscriptChunk[] {
  const byKey = new Map<string, ComposerTranscriptChunk>();
  for (const chunk of [...input.dbChunks, ...input.payloadChunks]) {
    const text = normalizeSpaces(chunk.text);
    if (!text || chunk.speaker === "assistant" || chunk.speaker === "system" || isPureFiller(text)) continue;
    const timeBucket = Math.floor(chunk.timestamp / EVIDENCE_DEDUPE_WINDOW_MS);
    const key = [chunk.speaker, normalizeQuestion(text), timeBucket].join(":");
    const existing = byKey.get(key);
    if (!existing || (existing.source !== "db" && chunk.source === "db")) {
      byKey.set(key, { ...chunk, text });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_EVIDENCE_CHUNKS);
}

async function loadEvidence(sessionId: string, metadata: AIAnswerLiveContextMetadata | undefined): Promise<ComposerTranscriptChunk[]> {
  const [dbChunks, payloadChunks] = await Promise.all([
    loadDbEvidence(sessionId),
    Promise.resolve(loadPayloadEvidence(metadata)),
  ]);
  return mergeEvidence({ dbChunks, payloadChunks });
}

async function acquireComposerLock(sessionId: string): Promise<boolean> {
  const lockValue = crypto.randomUUID();
  const result = await redisConnection
    .set(composerLockKey(sessionId), lockValue, "PX", LOCK_TTL_MS, "NX")
    .catch((error) => {
      console.warn("[question-composer] lock acquire failed", { sessionId, error });
      return null;
    });
  return result === "OK";
}

async function latestTranscriptChunk(sessionId: string): Promise<{ id: string; createdAt: string } | null> {
  const chunk = await prisma.transcriptChunk.findFirst({
    where: { sessionId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true },
  });
  return chunk ? { id: chunk.id, createdAt: chunk.createdAt.toISOString() } : null;
}

async function hasNewerChunk(sessionId: string, toTranscriptChunkId: string): Promise<boolean> {
  const anchor = await prisma.transcriptChunk.findUnique({
    where: { id: toTranscriptChunkId },
    select: { createdAt: true },
  });
  if (!anchor) return true;
  const newer = await prisma.transcriptChunk.findFirst({
    where: {
      sessionId,
      createdAt: { gt: anchor.createdAt },
    },
    select: { id: true },
  });
  return Boolean(newer);
}

function coerceIntentKind(value: unknown, question: string): IntentKind {
  const raw = String(value || "");
  const allowed: IntentKind[] = [
    "intro",
    "intro_projects",
    "project_deep_dive",
    "coding",
    "code_followup",
    "system_design",
    "behavioral",
    "scenario",
    "conceptual",
  ];
  return allowed.includes(raw as IntentKind) ? raw as IntentKind : inferIntent(question);
}

function coerceFollowupType(value: unknown, question: string): FollowupType | undefined {
  const raw = String(value || "");
  const allowed: FollowupType[] = [
    "clarification",
    "code_explanation",
    "testing",
    "optimization",
    "scenario_extension",
    "behavioral_probe",
  ];
  return allowed.includes(raw as FollowupType) ? raw as FollowupType : inferFollowupType(question);
}

function latestUnansweredIntent(ledger: IntentLedger): IntentLedgerEntry | undefined {
  return [...ledger.intents].reverse().find((intent) => intent.status === "unanswered");
}

function upsertIntent(input: {
  sessionId: string;
  ledger: IntentLedger;
  question: string;
  intent: IntentKind;
  confidence: number;
  evidenceChunkIds: string[];
  transcriptExcerpt: string;
  topic: string;
  parentIntentId?: string;
  followupType?: FollowupType;
  createdAt: string;
}): IntentLedger {
  const normalizedQuestion = normalizeQuestion(input.question);
  const id = stableIntentId(input.sessionId, `${normalizedQuestion}:${input.evidenceChunkIds.join(",")}`);
  const existingIndex = input.ledger.intents.findIndex(
    (intent) => intent.normalizedQuestion === normalizedQuestion && intent.status !== "answered",
  );
  const entry: IntentLedgerEntry = {
    id: existingIndex >= 0 ? input.ledger.intents[existingIndex].id : id,
    question: input.question,
    normalizedQuestion,
    intent: input.intent,
    status: input.confidence >= 0.35 ? "unanswered" : "ignored",
    evidenceChunkIds: input.evidenceChunkIds,
    transcriptExcerpt: input.transcriptExcerpt,
    topic: input.topic,
    ...(input.parentIntentId ? { parentIntentId: input.parentIntentId } : {}),
    ...(input.followupType ? { followupType: input.followupType } : {}),
    createdAt: existingIndex >= 0 ? input.ledger.intents[existingIndex].createdAt : input.createdAt,
  };
  const intents =
    existingIndex >= 0
      ? input.ledger.intents.map((intent, index) => index === existingIndex ? { ...intent, ...entry } : intent)
      : [...input.ledger.intents, entry];
  return {
    intents: intents.slice(-MAX_LEDGER_INTENTS),
    activeIntentId: entry.status === "unanswered" ? entry.id : input.ledger.activeIntentId,
  };
}

function createSelectionFromQuestion(input: {
  sessionId: string;
  source: Extract<ComposerSelection["source"], "degraded_hint" | "evidence_batch" | "composer">;
  question: string;
  intent: IntentKind;
  confidence: number;
  chunks: ComposerTranscriptChunk[];
  ledger: IntentLedger;
  answerLedger: AnswerLedger;
  evidenceChunkIds: string[];
  transcriptExcerpt: string;
  topic?: string;
  parentIntentId?: string;
  followupType?: FollowupType;
}): ComposerSelection {
  const question = sanitizeQuestion(input.question);
  const createdAt = new Date().toISOString();
  const lastAnswered = latestAnsweredIntent(input.ledger);
  const parentIntentId =
    input.parentIntentId ||
    (isFollowupQuestion(question) ? lastAnswered?.id : undefined);
  const ledger = upsertIntent({
    sessionId: input.sessionId,
    ledger: input.ledger,
    question,
    intent: parentIntentId ? "code_followup" : input.intent,
    confidence: input.confidence,
    evidenceChunkIds: input.evidenceChunkIds,
    transcriptExcerpt: input.transcriptExcerpt,
    topic: input.topic || deriveTopicFromAnyText(`${question} ${lastAnswered?.topic || ""}`) || "general",
    ...(parentIntentId ? { parentIntentId } : {}),
    followupType: input.followupType || inferFollowupType(question),
    createdAt,
  });
  const selected = latestUnansweredIntent(ledger);
  if (!selected) {
    return {
      source: "none",
      questions: [],
      intent: input.intent,
      confidence: 0,
      transcriptExcerpt: "",
      intentLedger: ledger,
      answerLedger: input.answerLedger,
    };
  }

  const chunkHash = buildChunkHash(input.chunks);
  const fromTranscriptChunkId = input.chunks.find((chunk) => chunk.transcriptChunkId)?.transcriptChunkId || "";
  const toTranscriptChunkId = [...input.chunks].reverse().find((chunk) => chunk.transcriptChunkId)?.transcriptChunkId || "";
  const lastTranscriptTimestamp = input.chunks[input.chunks.length - 1]?.createdAt || createdAt;
  const plan: ActiveAnswerPlan = {
    intentId: selected.id,
    questions: [selected.question],
    intent: selected.intent,
    confidence: input.confidence,
    evidenceChunkIds: selected.evidenceChunkIds,
    transcriptExcerpt: selected.transcriptExcerpt,
    isAnswerable: true,
    fromTranscriptChunkId,
    toTranscriptChunkId,
    lastTranscriptTimestamp,
    chunkHash,
    createdAt,
    expiresAt: new Date(Date.now() + ACTIVE_PLAN_TTL_SECONDS * 1000).toISOString(),
  };
  return {
    source: input.source,
    questions: plan.questions,
    intent: plan.intent,
    confidence: plan.confidence,
    transcriptExcerpt: plan.transcriptExcerpt,
    selectedIntent: selected,
    intentLedger: ledger,
    answerLedger: input.answerLedger,
    activePlan: plan,
  };
}

function buildEvidenceBatchFallback(input: {
  sessionId: string;
  chunks: ComposerTranscriptChunk[];
  ledger: IntentLedger;
  answerLedger: AnswerLedger;
}): ComposerSelection {
  const tail = input.chunks.slice(-12);
  const firstAskIndex = tail.findIndex((chunk) =>
    /\b(interview|introduce|yourself|explain|project|projects|done so far|experience|question|tell me|walk me)\b/i.test(
      chunk.text,
    ),
  );
  const selectedChunks = (firstAskIndex >= 0 ? tail.slice(firstAskIndex) : tail)
    .filter((chunk) => !isPureFiller(chunk.text))
    .slice(-8);
  const questionEvidenceChunks = selectedChunks.filter((chunk) => isQuestionLikeEvidence(chunk.text));
  const evidenceChunks = questionEvidenceChunks.length > 0 ? questionEvidenceChunks : selectedChunks;
  const evidenceText = evidenceChunks
    .map((chunk) => sanitizeQuestion(chunk.text).replace(/\s+/g, " "))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!evidenceText || isTinyQuestionFragment(evidenceText)) {
    return {
      source: "none",
      questions: [],
      intent: "conceptual",
      confidence: 0,
      transcriptExcerpt: "",
      intentLedger: input.ledger,
      answerLedger: input.answerLedger,
    };
  }

  const transcriptExcerpt = selectedChunks
    .map((chunk) => `${chunk.speaker}: ${chunk.text}`)
    .join("\n");
  return createSelectionFromQuestion({
    sessionId: input.sessionId,
    source: "evidence_batch",
    question: evidenceText,
    intent: inferIntent(evidenceText),
    confidence: 0.66,
    chunks: input.chunks,
    ledger: input.ledger,
    answerLedger: input.answerLedger,
    evidenceChunkIds: evidenceChunks.map((chunk) => chunkIdentity(chunk)),
    transcriptExcerpt,
    topic: deriveTopicFromAnyText(evidenceText) || "general",
  });
}

async function runComposerAI(input: {
  runtime: ComposeRuntimeInput;
  chunks: ComposerTranscriptChunk[];
  intentLedger: IntentLedger;
  answerLedger: AnswerLedger;
}): Promise<{
  questions: string[];
  intent: IntentKind;
  confidence: number;
  evidenceChunkIds: string[];
  transcriptExcerpt: string;
  isAnswerable: boolean;
  topic: string;
  parentIntentId?: string;
  followupType?: FollowupType;
}> {
  const system = [
    "You are ScribeShade's backend AI Question Composer.",
    "Return strict JSON only. No markdown.",
    "Compose the clean interview question(s) the candidate needs help answering from transcript evidence.",
    "Use all non-assistant evidence, including candidate speech when it repeats or requests an interviewer question.",
    "Do not invent questions. Do not use static fallback labels. Ignore filler and already answered questions.",
    "Bind follow-ups to prior intents when the new ask references prior answers, code, scenarios, or decisions.",
  ].join("\n");
  const user = JSON.stringify({
    outputContract: {
      questions: ["clean answerable question"],
      intent: "intro | intro_projects | project_deep_dive | coding | code_followup | system_design | behavioral | scenario | conceptual",
      confidence: "0..1",
      evidenceChunkIds: ["chunk ids"],
      transcriptExcerpt: "short exact evidence excerpt",
      isAnswerable: "boolean",
      topic: "short topic",
      parentIntentId: "prior intent id when follow-up, otherwise omit",
      followupType: "clarification | code_explanation | testing | optimization | scenario_extension | behavioral_probe or omit",
    },
    currentQuestionHint: input.runtime.currentQuestionHint || "",
    transcriptChunks: input.chunks.map((chunk) => ({
      id: chunkIdentity(chunk),
      speaker: chunk.speaker,
      text: chunk.text,
      timestamp: chunk.timestamp,
    })),
    intentLedger: input.intentLedger.intents.slice(-12),
    answerLedger: input.answerLedger.answers.slice(-8),
  });
  const composerModel =
    process.env.AI_QUESTION_COMPOSER_MODEL ||
    process.env.AI_SEGMENTER_MODEL ||
    process.env.AI_SESSION_DECISION_MODEL ||
    "openai/gpt-4o-mini";
  const result = input.runtime.ai.callModel({
    model: composerModel,
    maxOutputTokens: 700,
    provider: input.runtime.provider,
    store: false,
    sessionId: input.runtime.sessionId,
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
      setTimeout(() => reject(new Error("question_composer_timeout")), input.runtime.timeoutMs),
    ),
  ]);
  const raw = parseJsonObject(content);
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const parentIntentId =
    typeof data.parentIntentId === "string" && data.parentIntentId.trim()
      ? data.parentIntentId.trim()
      : "";
  const questions = safeStringArray(data.questions)
    .map(sanitizeQuestion)
    .filter((question) => parentIntentId || !isTinyQuestionFragment(question))
    .filter(Boolean)
    .slice(0, 4);
  const firstQuestion = questions[0] || "";
  return {
    questions,
    intent: coerceIntentKind(data.intent, firstQuestion),
    confidence: clampConfidence(Number(data.confidence || 0)),
    evidenceChunkIds: safeStringArray(data.evidenceChunkIds),
    transcriptExcerpt: clip(String(data.transcriptExcerpt || ""), 1200),
    isAnswerable: data.isAnswerable === true && questions.length > 0,
    topic: clip(String(data.topic || deriveTopicFromAnyText(firstQuestion) || "general"), 120),
    ...(parentIntentId
      ? { parentIntentId }
      : {}),
    ...(coerceFollowupType(data.followupType, firstQuestion)
      ? { followupType: coerceFollowupType(data.followupType, firstQuestion) }
      : {}),
  };
}

async function composeAndPersist(input: ComposeRuntimeInput): Promise<ComposerSelection> {
  const [chunks, intentLedger, answerLedger] = await Promise.all([
    loadEvidence(input.sessionId, input.metadata),
    readIntentLedger(input.sessionId),
    readAnswerLedger(input.sessionId),
  ]);
  if (chunks.length === 0) {
    return {
      source: "none",
      questions: [],
      intent: "conceptual",
      confidence: 0,
      transcriptExcerpt: "",
      intentLedger,
      answerLedger,
    };
  }

  let composerResult: Awaited<ReturnType<typeof runComposerAI>> | null = null;
  try {
    composerResult = await runComposerAI({
      runtime: input,
      chunks,
      intentLedger,
      answerLedger,
    });
  } catch (error) {
    console.warn("[question-composer] ai compose failed", {
      sessionId: input.sessionId,
      error,
    });
  }

  if (!composerResult?.isAnswerable || composerResult.questions.length === 0) {
    if (isCleanCompleteQuestionHint(input.currentQuestionHint || "")) {
      const hintSelection = createSelectionFromQuestion({
        sessionId: input.sessionId,
        source: "degraded_hint",
        question: input.currentQuestionHint || "",
        intent: inferIntent(input.currentQuestionHint || ""),
        confidence: 0.62,
        chunks,
        ledger: intentLedger,
        answerLedger,
        evidenceChunkIds: [],
        transcriptExcerpt: chunks.slice(-8).map((chunk) => `${chunk.speaker}: ${chunk.text}`).join("\n"),
      });
      await writeIntentLedger(input.sessionId, hintSelection.intentLedger);
      if (hintSelection.activePlan) await writeActiveAnswerPlan(input.sessionId, hintSelection.activePlan);
      return hintSelection;
    }

    const fallback = buildEvidenceBatchFallback({
      sessionId: input.sessionId,
      chunks,
      ledger: intentLedger,
      answerLedger,
    });
    await writeIntentLedger(input.sessionId, fallback.intentLedger);
    if (fallback.activePlan) await writeActiveAnswerPlan(input.sessionId, fallback.activePlan);
    return fallback;
  }

  const createdAt = new Date().toISOString();
  const lastAnswered = latestAnsweredIntent(intentLedger);
  const parentIntentId =
    composerResult.parentIntentId ||
    (isFollowupQuestion(composerResult.questions.join(" ")) ? lastAnswered?.id : undefined);
  let nextLedger = intentLedger;
  for (const question of composerResult.questions) {
    nextLedger = upsertIntent({
      sessionId: input.sessionId,
      ledger: nextLedger,
      question,
      intent: parentIntentId ? "code_followup" : composerResult.intent,
      confidence: composerResult.confidence,
      evidenceChunkIds: composerResult.evidenceChunkIds,
      transcriptExcerpt: composerResult.transcriptExcerpt,
      topic: composerResult.topic,
      ...(parentIntentId ? { parentIntentId } : {}),
      ...(composerResult.followupType ? { followupType: composerResult.followupType } : {}),
      createdAt,
    });
  }
  const selected = latestUnansweredIntent(nextLedger);
  await writeIntentLedger(input.sessionId, nextLedger);
  if (!selected) {
    return {
      source: "none",
      questions: [],
      intent: composerResult.intent,
      confidence: composerResult.confidence,
      transcriptExcerpt: composerResult.transcriptExcerpt,
      intentLedger: nextLedger,
      answerLedger,
    };
  }

  const chunkHash = buildChunkHash(chunks);
  const fromTranscriptChunkId = chunks.find((chunk) => chunk.transcriptChunkId)?.transcriptChunkId || "";
  const toTranscriptChunkId = [...chunks].reverse().find((chunk) => chunk.transcriptChunkId)?.transcriptChunkId || "";
  const lastTranscriptTimestamp = chunks[chunks.length - 1]?.createdAt || createdAt;
  const plan: ActiveAnswerPlan = {
    intentId: selected.id,
    questions: composerResult.questions,
    intent: selected.intent,
    confidence: composerResult.confidence,
    evidenceChunkIds: composerResult.evidenceChunkIds,
    transcriptExcerpt: composerResult.transcriptExcerpt,
    isAnswerable: true,
    fromTranscriptChunkId,
    toTranscriptChunkId,
    lastTranscriptTimestamp,
    chunkHash,
    createdAt,
    expiresAt: new Date(Date.now() + ACTIVE_PLAN_TTL_SECONDS * 1000).toISOString(),
  };
  await writeActiveAnswerPlan(input.sessionId, plan);
  return {
    source: "composer",
    questions: plan.questions,
    intent: plan.intent,
    confidence: plan.confidence,
    transcriptExcerpt: plan.transcriptExcerpt,
    selectedIntent: selected,
    intentLedger: nextLedger,
    answerLedger,
    activePlan: plan,
  };
}

export function scheduleQuestionComposer(input: {
  sessionId: string;
  metadata?: AIAnswerLiveContextMetadata;
  currentQuestionHint?: string;
  ai: any;
  model?: string;
  provider?: any;
}): void {
  const existingTimer = debounceTimers.get(input.sessionId);
  if (existingTimer) clearTimeout(existingTimer);
  redisConnection
    .set(composerDebounceKey(input.sessionId), new Date().toISOString(), "EX", DEBOUNCE_TTL_SECONDS)
    .catch((error) => {
      console.warn("[question-composer] debounce marker write failed", {
        sessionId: input.sessionId,
        error,
      });
    });
  const timer = setTimeout(() => {
    debounceTimers.delete(input.sessionId);
    void (async () => {
      const locked = await acquireComposerLock(input.sessionId);
      if (!locked) return;
      await composeAndPersist({
        sessionId: input.sessionId,
        metadata: input.metadata,
        currentQuestionHint: input.currentQuestionHint,
        ai: input.ai,
        model: input.model,
        provider: input.provider,
        timeoutMs: PRECOMPOSE_TIMEOUT_MS,
      }).catch((error) => {
        console.warn("[question-composer] scheduled compose failed", {
          sessionId: input.sessionId,
          error,
        });
      });
    })();
  }, DEBOUNCE_MS);
  debounceTimers.set(input.sessionId, timer);
}

async function validateCachedPlan(input: {
  sessionId: string;
  plan: ActiveAnswerPlan;
}): Promise<boolean> {
  if (!input.plan.isAnswerable) return false;
  if (input.plan.confidence < ACTIVE_PLAN_CONFIDENCE_THRESHOLD) return false;
  if (input.plan.consumedAt) return false;
  if (new Date(input.plan.expiresAt).getTime() <= Date.now()) return false;
  if (!input.plan.toTranscriptChunkId) return false;
  if (await hasNewerChunk(input.sessionId, input.plan.toTranscriptChunkId)) return false;
  const chunks = await loadEvidence(input.sessionId, undefined);
  return chunks.length > 0 && buildChunkHash(chunks) === input.plan.chunkHash;
}

function selectedIntentByMode(input: {
  metadata?: AIAnswerLiveContextMetadata;
  mode: AnswerClickMode;
  intentLedger: IntentLedger;
}): IntentLedgerEntry | undefined {
  const selectedIntentId = input.metadata?.selectedIntentId || input.metadata?.selectedAnswerIntentId;
  if (input.mode === "answer_selected_intent" && selectedIntentId) {
    return input.intentLedger.intents.find((intent) => intent.id === selectedIntentId);
  }
  if ((input.mode === "reanswer_previous" || input.mode === "regenerate_answer") && input.metadata?.selectedAnswerQuestion) {
    const normalized = normalizeQuestion(input.metadata.selectedAnswerQuestion);
    return [...input.intentLedger.intents].reverse().find((intent) => intent.normalizedQuestion === normalized);
  }
  if (input.mode === "answer_followup") {
    return latestUnansweredIntent(input.intentLedger) || latestAnsweredIntent(input.intentLedger);
  }
  return undefined;
}

function selectionFromIntent(input: {
  source: ComposerSelection["source"];
  intent: IntentLedgerEntry;
  intentLedger: IntentLedger;
  answerLedger: AnswerLedger;
}): ComposerSelection {
  return {
    source: input.source,
    questions: [input.intent.question],
    intent: input.intent.intent,
    confidence: 0.95,
    transcriptExcerpt: input.intent.transcriptExcerpt,
    selectedIntent: input.intent,
    intentLedger: input.intentLedger,
    answerLedger: input.answerLedger,
  };
}

export async function resolveAnswerSelection(input: {
  sessionId: string;
  mode: AnswerClickMode;
  metadata?: AIAnswerLiveContextMetadata;
  currentQuestionHint?: string;
  isCustomQuery: boolean;
  isRegenerate: boolean;
  ai: any;
  model?: string;
  provider?: any;
}): Promise<ComposerSelection> {
  const [intentLedger, answerLedger] = await Promise.all([
    readIntentLedger(input.sessionId),
    readAnswerLedger(input.sessionId),
  ]);

  const explicitManual = normalizeSpaces(input.currentQuestionHint || "");
  if (input.isCustomQuery && explicitManual) {
    return {
      source: "manual",
      questions: [sanitizeQuestion(explicitManual)],
      intent: inferIntent(explicitManual),
      confidence: 1,
      transcriptExcerpt: "",
      intentLedger,
      answerLedger,
    };
  }

  const selected = selectedIntentByMode({
    metadata: input.metadata,
    mode: input.mode,
    intentLedger,
  });
  if (selected) {
    return selectionFromIntent({
      source: input.mode === "answer_selected_intent" ? "selected_intent" : "reanswer",
      intent: selected,
      intentLedger,
      answerLedger,
    });
  }

  const activePlan = await readActiveAnswerPlan(input.sessionId);
  if (activePlan && await validateCachedPlan({ sessionId: input.sessionId, plan: activePlan })) {
    const activeIntent =
      intentLedger.intents.find((intent) => intent.id === activePlan.intentId) ||
      latestUnansweredIntent(intentLedger);
    return {
      source: "active_plan",
      questions: activePlan.questions,
      intent: activePlan.intent,
      confidence: activePlan.confidence,
      transcriptExcerpt: activePlan.transcriptExcerpt,
      ...(activeIntent ? { selectedIntent: activeIntent } : {}),
      intentLedger,
      answerLedger,
      activePlan,
    };
  }

  const composed = await composeAndPersist({
    sessionId: input.sessionId,
    metadata: input.metadata,
    currentQuestionHint: input.currentQuestionHint,
    ai: input.ai,
    model: input.model,
    provider: input.provider,
    timeoutMs: input.isRegenerate ? REGENERATE_COMPOSER_TIMEOUT_MS : CLICK_COMPOSER_TIMEOUT_MS,
  });
  if (composed.questions.length > 0) return composed;

  if (explicitManual && isCleanCompleteQuestionHint(explicitManual)) {
    return {
      source: "degraded_hint",
      questions: [sanitizeQuestion(explicitManual)],
      intent: inferIntent(explicitManual),
      confidence: 0.5,
      transcriptExcerpt: "",
      intentLedger: composed.intentLedger,
      answerLedger: composed.answerLedger,
    };
  }

  if (activePlan && activePlan.isAnswerable && !activePlan.consumedAt) {
    return {
      source: "active_plan",
      questions: activePlan.questions,
      intent: activePlan.intent,
      confidence: activePlan.confidence,
      transcriptExcerpt: activePlan.transcriptExcerpt,
      intentLedger: composed.intentLedger,
      answerLedger: composed.answerLedger,
      activePlan,
    };
  }

  return {
    source: "none",
    questions: [],
    intent: "conceptual",
    confidence: 0,
    transcriptExcerpt: "",
    intentLedger: composed.intentLedger,
    answerLedger: composed.answerLedger,
  };
}

function summarizeAnswer(answer: string): string {
  return clip(answer.replace(/\*\*QUESTION:\*\*[\s\S]*?\*\*ANSWER:\*\*/i, ""), 700);
}

function extractKeyClaims(answer: string): string[] {
  return answer
    .split(/\r?\n/)
    .map((line) => normalizeSpaces(line.replace(/^[-*]\s*/, "")))
    .filter((line) => line.length > 20 && !/^(\*\*)?question:/i.test(line) && !/^(\*\*)?answer:/i.test(line))
    .slice(0, 6);
}

function extractCodeBlocks(answer: string): AnswerLedgerEntry["codeBlocks"] {
  const matches = answer.match(/```([a-z0-9+#.-]*)\s*([\s\S]*?)```/gi) || [];
  return matches.slice(0, 4).map((block, index) => {
    const language = block.match(/^```([a-z0-9+#.-]*)/i)?.[1] || "text";
    const body = block.replace(/^```[a-z0-9+#.-]*\s*/i, "").replace(/```$/i, "");
    return {
      language,
      purpose: `code block ${index + 1}`,
      summary: clip(body, 240),
      codeHash: sha1(body).slice(0, 16),
    };
  });
}

export async function recordAnswerInLedgers(input: {
  sessionId: string;
  answerId: string;
  question: string;
  answer: string;
  topic?: string;
  intentId?: string;
}): Promise<void> {
  const [intentLedger, answerLedger, activePlan] = await Promise.all([
    readIntentLedger(input.sessionId),
    readAnswerLedger(input.sessionId),
    readActiveAnswerPlan(input.sessionId),
  ]);
  const normalizedQuestion = normalizeQuestion(input.question);
  const intent =
    (input.intentId ? intentLedger.intents.find((entry) => entry.id === input.intentId) : undefined) ||
    intentLedger.intents.find((entry) => entry.normalizedQuestion === normalizedQuestion) ||
    intentLedger.intents.find((entry) => entry.id === activePlan?.intentId);
  const intentId = intent?.id || stableIntentId(input.sessionId, input.question);
  const topic = input.topic || intent?.topic || deriveTopicFromAnyText(input.question) || "general";
  const now = new Date().toISOString();
  const updatedIntents = intentLedger.intents.map((entry) =>
    entry.id === intentId
      ? {
          ...entry,
          status: "answered" as const,
          answerId: input.answerId,
          answeredAt: now,
        }
      : entry,
  );
  const hasExistingIntent = updatedIntents.some((entry) => entry.id === intentId);
  const nextIntentLedger: IntentLedger = {
    intents: hasExistingIntent
      ? updatedIntents
      : [
          ...updatedIntents,
          {
            id: intentId,
            question: input.question,
            normalizedQuestion,
            intent: inferIntent(input.question),
            status: "answered",
            evidenceChunkIds: [],
            transcriptExcerpt: "",
            topic,
            answerId: input.answerId,
            createdAt: now,
            answeredAt: now,
          },
        ],
    activeIntentId:
      intentLedger.activeIntentId === intentId
        ? latestUnansweredIntent({ intents: updatedIntents })?.id
        : intentLedger.activeIntentId,
  };
  await writeIntentLedger(input.sessionId, nextIntentLedger);

  const answerEntry: AnswerLedgerEntry = {
    answerId: input.answerId,
    intentId,
    question: input.question,
    answerSummary: summarizeAnswer(input.answer),
    keyClaims: extractKeyClaims(input.answer),
    ...(extractCodeBlocks(input.answer)?.length
      ? { codeBlocks: extractCodeBlocks(input.answer) }
      : {}),
    topic,
    createdAt: now,
  };
  await writeAnswerLedger(input.sessionId, {
    answers: [
      ...answerLedger.answers.filter((entry) => entry.answerId !== input.answerId),
      answerEntry,
    ].slice(-MAX_LEDGER_ANSWERS),
  });

  if (activePlan && activePlan.intentId === intentId) {
    await writeActiveAnswerPlan(input.sessionId, {
      ...activePlan,
      consumedAt: now,
      answeredQuestionHash: sha1(normalizedQuestion),
    });
  }
}

/**
 * Token-overlap similarity of two already-normalized question strings.
 * Returns a 0..1 Jaccard ratio over word sets. Pure and allocation-light so
 * it is safe on the live pre-model path.
 */
function questionTokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(" ").filter(Boolean));
  const tokensB = new Set(b.split(" ").filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection += 1;
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export type RecentlyAnsweredMatch = {
  isSame: boolean;
  matchedAnswerId: string | null;
  matchedQuestion: string | null;
  similarity: number;
  reason: "exact_normalized" | "high_similarity" | "no_match";
};

/**
 * Detects whether a resolved target question is effectively the same as a
 * question that was just answered in this session. Used as an auto-trigger
 * safety net so a still-evolving interviewer question does not spawn
 * duplicate/conflicting answer cards. Explicit AI Answer clicks must NOT use
 * this to suppress output (always-answer contract); callers gate on that.
 */
export function matchRecentlyAnsweredQuestion(input: {
  question: string;
  answerLedger: AnswerLedger;
  lookback?: number;
  similarityThreshold?: number;
}): RecentlyAnsweredMatch {
  const normalized = normalizeQuestion(input.question);
  const none: RecentlyAnsweredMatch = {
    isSame: false,
    matchedAnswerId: null,
    matchedQuestion: null,
    similarity: 0,
    reason: "no_match",
  };
  if (!normalized) return none;
  const lookback = input.lookback ?? 3;
  const threshold = input.similarityThreshold ?? 0.82;
  const recent = [...(input.answerLedger.answers || [])].slice(-lookback).reverse();
  let best = none;
  for (const answer of recent) {
    const candidate = normalizeQuestion(answer.question);
    if (!candidate) continue;
    if (candidate === normalized) {
      return {
        isSame: true,
        matchedAnswerId: answer.answerId,
        matchedQuestion: answer.question,
        similarity: 1,
        reason: "exact_normalized",
      };
    }
    const similarity = questionTokenSimilarity(normalized, candidate);
    if (similarity > best.similarity) {
      best = {
        isSame: similarity >= threshold,
        matchedAnswerId: answer.answerId,
        matchedQuestion: answer.question,
        similarity,
        reason: similarity >= threshold ? "high_similarity" : "no_match",
      };
    }
  }
  return best;
}

export async function rebuildLedgersFromDurableState(sessionId: string): Promise<{
  intentLedger: IntentLedger;
  answerLedger: AnswerLedger;
}> {
  const [qas, snapshots] = await Promise.all([
    prisma.qA.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
      take: 40,
      select: { id: true, ques: true, answer: true, createdAt: true },
    }),
    prisma.answerGenerationSnapshot.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
      take: 40,
      select: { id: true, originalQuestionTranscript: true, generatedAnswer: true, detectedIntent: true, createdAt: true },
    }),
  ]);
  const answers = [
    ...qas.map((qa) => ({
      answerId: qa.id,
      question: qa.ques,
      answer: qa.answer || "",
      createdAt: qa.createdAt,
    })),
    ...snapshots.map((snapshot) => ({
      answerId: snapshot.id,
      question: snapshot.originalQuestionTranscript,
      answer: snapshot.generatedAnswer,
      createdAt: snapshot.createdAt,
    })),
  ].filter((entry) => entry.question.trim() && entry.answer.trim());

  let intentLedger: IntentLedger = { intents: [] };
  let answerLedger: AnswerLedger = { answers: [] };
  for (const entry of answers) {
    const question = sanitizeQuestion(entry.question);
    const intentId = stableIntentId(sessionId, question);
    const topic = deriveTopicFromAnyText(question) || "general";
    intentLedger.intents.push({
      id: intentId,
      question,
      normalizedQuestion: normalizeQuestion(question),
      intent: inferIntent(question),
      status: "answered",
      evidenceChunkIds: [],
      transcriptExcerpt: "",
      topic,
      answerId: entry.answerId,
      createdAt: entry.createdAt.toISOString(),
      answeredAt: entry.createdAt.toISOString(),
    });
    answerLedger.answers.push({
      answerId: entry.answerId,
      intentId,
      question,
      answerSummary: summarizeAnswer(entry.answer),
      keyClaims: extractKeyClaims(entry.answer),
      ...(extractCodeBlocks(entry.answer)?.length
        ? { codeBlocks: extractCodeBlocks(entry.answer) }
        : {}),
      topic,
      createdAt: entry.createdAt.toISOString(),
    });
  }
  intentLedger = { intents: intentLedger.intents.slice(-MAX_LEDGER_INTENTS) };
  answerLedger = { answers: answerLedger.answers.slice(-MAX_LEDGER_ANSWERS) };
  await Promise.all([
    writeIntentLedger(sessionId, intentLedger),
    writeAnswerLedger(sessionId, answerLedger),
  ]);
  return { intentLedger, answerLedger };
}

export function composerSelectionToQuestionMeta(selection: ComposerSelection): {
  displayQuestion: string;
  intent: string;
  confidence: number;
  topic: string;
  isFollowUp: boolean;
  shouldAnswer: boolean;
  source: string;
  corrections: [];
} {
  return {
    displayQuestion: selection.questions.join(" | "),
    intent: selection.intent,
    confidence: selection.confidence,
    topic: selection.selectedIntent?.topic || deriveTopicFromAnyText(selection.questions.join(" ")) || "general",
    isFollowUp: Boolean(selection.selectedIntent?.parentIntentId || selection.selectedIntent?.followupType),
    shouldAnswer: selection.questions.length > 0,
    source: `question_composer_${selection.source}`,
    corrections: [],
  };
}
