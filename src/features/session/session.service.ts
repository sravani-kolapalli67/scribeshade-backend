import { prisma } from "../../shared/lib/prisma";
import { OpenRouter } from "@openrouter/sdk";
import { CreateSessionData } from "./session.types";
import * as qaService from "../qa/qa.service";
import sharp from "sharp";
import { Language, Industry, SessionStatus, DeductionReason, Prisma, SpeakerType, ChunkType } from "@prisma/client";
import * as documentService from "../document/document.service";
import path from "path";
import { AppError } from "../../shared/middleware/error.middleware";
import * as creditsService from "../credits/credits.service";
import { creditDeductionQueue } from "../jobs/queue";
import { buildSystemMessage, buildUserMessage, buildScreenAnalysisMessage, buildScreenSystemMessage } from "../../shared/lib/prompt";
import {
  buildOptimizedContext,
  isProjectOverviewQuestion,
  isProjectExperienceQuestion,
} from "./cie.service";
import { getUnifiedResumeContext } from "../resume/resume.service";
import crypto from "crypto";
import {
  ANALYTICS_SYSTEM_PROMPT,
  buildAnalyticsUserPrompt,
} from "../../shared/prompts/analytics";
import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";
import { buildRequestScopedPolicy } from "./answer-policy";
import {
  decideAISessionState,
  fallbackAISessionDecision,
  toDecisionContextTargets,
} from "./ai-session-decision";
import {
  buildEffectiveLiveContextMetadata,
  classifyConversationIntent,
  deriveTopic,
  deriveTopicFromAnyText,
  guardCurrentQuestion,
  isCodeFollowupQuestion,
  isFollowupConversationIntent,
  normalizeTranscriptForQuestionDetection,
  resolveFollowupTarget,
  selectTargetCodeContext,
  toAnswerHistory,
} from "./answer-quality";
import {
  enqueueCandidateDigestWarmup,
} from "./candidate-digest.service";
import {
  orchestrateAIContext,
  type ContextOrchestrationResult,
  type QuestionMeta,
} from "./context-orchestrator.service";
import { writeTopicMemory } from "./topic-memory.service";
import { writeTurnMemory } from "./turn-memory.service";

const ai = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY || "",
  httpReferer: "https://scribeshade.com",
  appTitle: "ScribeShade",
});

const model = process.env.OPENROUTER_MODEL;
const ACTIVE_QUESTION_CONFIDENCE_THRESHOLD = 0.58;
const AI_DECISION_CONFIDENCE_THRESHOLD = 0.62;
const LIVE_TRANSCRIPT_GROUP_ID = "live-transcript";
const LEGACY_TRANSCRIPT_FLUSH_DELAY_MS = Number(process.env.LEGACY_TRANSCRIPT_FLUSH_DELAY_MS || 7000);
const liveTranscriptFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

type LiveMessageRole = "INTERVIEWER" | "AI_ASSISTANT" | "USER";

type LegacyTranscriptSnapshot = {
  messageId?: string;
  role: LiveMessageRole;
  question: string;
  answer: string;
  timestamp: string;
  time?: string;
  snapshotId?: string;
};

type AppendMessageResult = {
  messageId?: string;
  transcriptChunkId?: string;
  saved: boolean;
};

const SESSION_LIST_SELECT = {
  id: true,
  companyName: true,
  jobDescription: true,
  mode: true,
  free: true,
  aiUsage: true,
  status: true,
  endedAt: true,
  createdAt: true,
  updatedAt: true,
  autoGenerateResponse: true,
  saveTranscription: true,
  creditsDeducted: true,
  deductionReason: true,
  company: {
    select: {
      name: true,
    },
  },
} satisfies Prisma.SessionSelect;

type SessionListFilters = {
  search?: string;
  from_date?: string;
  to_date?: string;
};

const sessionListInFlight = new Map<
  string,
  Promise<Prisma.SessionGetPayload<{ select: typeof SESSION_LIST_SELECT }>[]>
>();

function createSessionListCacheKey(userId: string, filters?: SessionListFilters): string {
  return JSON.stringify({
    userId,
    search: filters?.search ?? "",
    from_date: filters?.from_date ?? "",
    to_date: filters?.to_date ?? "",
  });
}

function buildSessionListWhere(userId: string, filters?: SessionListFilters): Prisma.SessionWhereInput {
  const where: Prisma.SessionWhereInput = { userId };

  if (filters?.search) {
    where.companyName = { contains: filters.search, mode: "insensitive" };
  }

  if (filters?.from_date || filters?.to_date) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (filters.from_date) {
      createdAt.gte = new Date(filters.from_date);
    }
    if (filters.to_date) {
      const to = new Date(filters.to_date);
      to.setHours(23, 59, 59, 999);
      createdAt.lte = to;
    }
    where.createdAt = createdAt;
  }

  return where;
}

function mapLiveRoleToSpeakerType(role: LiveMessageRole): SpeakerType {
  if (role === "INTERVIEWER") return SpeakerType.INTERVIEWER;
  if (role === "AI_ASSISTANT") return SpeakerType.ASSISTANT;
  return SpeakerType.CANDIDATE;
}

function mapSpeakerTypeToLiveRole(speakerType: SpeakerType | null): LiveMessageRole {
  if (speakerType === SpeakerType.INTERVIEWER) return "INTERVIEWER";
  if (speakerType === SpeakerType.ASSISTANT) return "AI_ASSISTANT";
  return "USER";
}

function mapLiveRoleToChunkType(role: LiveMessageRole): ChunkType {
  if (role === "AI_ASSISTANT") return ChunkType.ANSWER;
  if (role === "INTERVIEWER") return ChunkType.QUESTION;
  return ChunkType.CONTEXT;
}

function buildTranscriptContent(question: string, answer: string): string {
  return answer ? `Q: ${question}\n\nA: ${answer}` : question;
}

function legacyMessageFromChunk(chunk: {
  questionId: string | null;
  speakerType: SpeakerType | null;
  question: string | null;
  aiAnswer: string | null;
  content: string;
  startTime: number | null;
  createdAt: Date;
}): LegacyTranscriptSnapshot {
  const role = mapSpeakerTypeToLiveRole(chunk.speakerType);
  const question = chunk.question || chunk.content || "";
  const answer = chunk.aiAnswer || "";
  const createdAt = chunk.createdAt.toISOString();
  return {
    messageId: chunk.questionId?.replace(/^live:/, ""),
    role,
    question,
    answer,
    timestamp: createdAt,
    time:
      typeof chunk.startTime === "number" && chunk.startTime > 0
        ? new Date(chunk.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : undefined,
  };
}

function legacyTranscriptEntryFromMessage(message: LegacyTranscriptSnapshot) {
  return {
    ...message,
    messageId: message.messageId,
    role: message.role,
    question: message.question,
    answer: message.answer,
    content: buildTranscriptContent(message.question, message.answer),
    time:
      message.time ||
      new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    createdAt: message.timestamp,
    snapshotId: message.snapshotId,
  };
}

function mergeLegacyMessages(
  existing: unknown,
  liveMessages: LegacyTranscriptSnapshot[],
): LegacyTranscriptSnapshot[] {
  const result = Array.isArray(existing) ? [...(existing as LegacyTranscriptSnapshot[])] : [];
  const indexByMessageId = new Map<string, number>();
  result.forEach((message, index) => {
    if (message?.messageId) indexByMessageId.set(message.messageId, index);
  });

  liveMessages.forEach((message) => {
    if (message.messageId && indexByMessageId.has(message.messageId)) {
      result[indexByMessageId.get(message.messageId) as number] = {
        ...result[indexByMessageId.get(message.messageId) as number],
        ...message,
      };
      return;
    }
    result.push(message);
    if (message.messageId) indexByMessageId.set(message.messageId, result.length - 1);
  });

  return result;
}

async function flushSessionTranscriptLegacySnapshot(sessionId: string): Promise<void> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, messages: true, transcript: true, saveTranscription: true },
  });
  if (!session || session.saveTranscription === false) return;

  const chunks = await prisma.transcriptChunk.findMany({
    where: {
      sessionId,
      questionGroupId: LIVE_TRANSCRIPT_GROUP_ID,
    },
    orderBy: [{ startTime: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      questionId: true,
      speakerType: true,
      question: true,
      aiAnswer: true,
      content: true,
      startTime: true,
      createdAt: true,
    },
  });
  if (chunks.length === 0) return;

  const liveMessages = chunks.map(legacyMessageFromChunk);
  const messages = mergeLegacyMessages(session.messages, liveMessages);
  const transcript = messages.map(legacyTranscriptEntryFromMessage);

  await prisma.session.update({
    where: { id: sessionId },
    data: { messages, transcript },
  });
}

function scheduleLegacyTranscriptFlush(sessionId: string, delayMs: number): void {
  const existing = liveTranscriptFlushTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    liveTranscriptFlushTimers.delete(sessionId);
    flushSessionTranscriptLegacySnapshot(sessionId).catch((error) => {
      console.error("[live-transcript-flush] failed", { sessionId, error });
    });
  }, delayMs);
  liveTranscriptFlushTimers.set(sessionId, timer);
}

export async function forceFlushSessionTranscript(sessionId: string): Promise<void> {
  const existing = liveTranscriptFlushTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    liveTranscriptFlushTimers.delete(sessionId);
  }
  await flushSessionTranscriptLegacySnapshot(sessionId);
}

function uniqNonEmptyStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function resolveSessionProjectSelection(input: {
  projectIds?: string[];
  primaryProjectId?: string;
}): { projectIds: string[]; primaryProjectId: string | null } {
  const deduped = uniqNonEmptyStrings(input.projectIds ?? []);
  if (deduped.length > 2) {
    throw new AppError(400, "A maximum of 2 projects can be selected for a session");
  }
  if (deduped.length === 0) {
    return { projectIds: [], primaryProjectId: null };
  }
  if (deduped.length === 1) {
    return { projectIds: deduped, primaryProjectId: deduped[0] };
  }

  const primary = typeof input.primaryProjectId === "string"
    ? input.primaryProjectId.trim()
    : "";
  if (!primary) {
    throw new AppError(400, "primaryProjectId is required when selecting 2 projects");
  }
  if (!deduped.includes(primary)) {
    throw new AppError(400, "primaryProjectId must be one of selected projectIds");
  }
  return { projectIds: deduped, primaryProjectId: primary };
}

function orderProjectRecordsBySelection(
  records: any[],
  selectedIds: string[],
  primaryProjectId?: string | null,
): any[] {
  const order = new Map<string, number>();
  if (primaryProjectId) order.set(primaryProjectId, 0);
  let offset = primaryProjectId ? 1 : 0;
  for (const id of selectedIds) {
    if (id === primaryProjectId) continue;
    if (!order.has(id)) order.set(id, offset++);
  }
  return [...records].sort((a, b) => {
    const ai = order.get(String(a?.id ?? "")) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(String(b?.id ?? "")) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

/** Normalize human-readable model names sent by frontend to valid OpenRouter slugs */
const MODEL_ID_MAP: Record<string, string> = {
  "gemini 2.0 flash": "google/gemini-2.0-flash-001",
  "gemini 2.0 flash exp": "google/gemini-2.0-flash-exp:free",
  "gemini 1.5 flash": "google/gemini-flash-1.5",
  "gemini 1.5 pro": "google/gemini-pro-1.5",
  "gemini 3.1 flash lite": "google/gemini-3.1-flash-lite-preview",
  "gemini 3.1 pro": "google/gemini-3.1-pro-preview",
  "gpt-4o": "openai/gpt-4o",
  "gpt-4o mini": "openai/gpt-4o-mini",
  "gpt-5": "openai/gpt-5",
  "claude 3.5 sonnet": "anthropic/claude-3.5-sonnet",
  "claude 3 haiku": "anthropic/claude-3-haiku",
  "claude 4.6 sonnet": "anthropic/claude-sonnet-4.6",
  "claude haiku 4.5": "anthropic/claude-haiku-4-5",
};

function resolveModelId(id: string | undefined): string | undefined {
  if (!id) return id;
  const normalized = id.toLowerCase().trim();
  return MODEL_ID_MAP[normalized] ?? id;
}

const latencyOptimizedProvider = {
  sort: "latency",
  allowFallbacks: true,
  preferredMaxLatency: 3,
  preferredMinThroughput: 30,
};

function estimatePromptTokensForLog(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateIndependentQuestionCount(text: string): number {
  if (!text?.trim()) return 1;
  const questionMarks = (text.match(/\?/g) || []).length;
  const numbered = (text.match(/(?:^|\n)\s*(?:\d+[\s.)-]+|q\d+[:.)-])/gi) || []).length;
  const spokenSequence = (text.match(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s*:/gi) || []).length;
  return Math.max(1, questionMarks, numbered, spokenSequence);
}

function resolveAnswerMaxOutputTokens(params: {
  complexity?: string;
  question: string;
  isRegenerate?: boolean;
  hasProjects?: boolean;
}) {
  const questionCount = estimateIndependentQuestionCount(params.question);
  if (questionCount >= 3) return Math.min(8000, questionCount * 900);
  if (questionCount === 2) return 2200;
  if (params.hasProjects && isProjectOverviewQuestion(params.question)) return 3600;
  if (params.isRegenerate) return 2400;

  switch (params.complexity) {
    case "simple_atomic":
      return 700;
    case "simple_contextual":
      return 1100;
    case "followup":
      return 1100;
    case "scenario_based":
      return 1800;
    case "system_design":
      return 2600;
    default:
      return 1800;
  }
}

function resolveScreenMaxOutputTokens() {
  const fromEnv = Number(process.env.AI_SCREEN_MAX_OUTPUT_TOKENS || "");
  if (Number.isFinite(fromEnv) && fromEnv >= 1000) {
    return Math.min(Math.floor(fromEnv), 8000);
  }
  return 5500;
}

function isProjectExplainQuestion(question: string): boolean {
  const q = (question || "").toLowerCase().trim();
  if (!q) return false;
  return /\b(explain|describe|walk me through|tell me about)\b[\s\w]{0,40}\b(your\s+)?projects?\b/.test(q);
}

function extractArchitectureDiagramBlock(projectsContext: unknown): string | null {
  if (typeof projectsContext !== "string" || !projectsContext.trim()) return null;

  const match = projectsContext.match(
    /\[Architecture Diagram\]:\s*```text\s*([\s\S]*?)```/i,
  );
  if (!match?.[1]) return null;

  const lines = match[1]
    .split(/\r?\n/)
    .map((line: string) => line.replace(/\t/g, "  ").trimEnd())
    .filter(Boolean)
    .slice(0, 16);
  if (lines.length === 0) return null;

  return lines.join("\n");
}

function synthesizeArchitectureFlowFromProjectContext(
  projectsContext: unknown,
): string | null {
  if (typeof projectsContext !== "string" || !projectsContext.trim()) return null;
  const text = projectsContext;
  const architectureLine =
    text.match(/\[Architecture\]:\s*([^\n]+)/i)?.[1]?.trim() || "";
  const flowLine =
    text.match(/\[Flow\]:\s*([^\n]+)/i)?.[1]?.trim() || "";
  const techLine =
    text.match(/\[Tech\]:\s*([^\n]+)/i)?.[1]?.trim() || "";

  if (flowLine) {
    return flowLine.replace(/\s+/g, " ").slice(0, 220);
  }

  if (architectureLine) {
    const compact = architectureLine.replace(/\s+/g, " ").slice(0, 220);
    if (compact.includes("->")) return compact;
    return `Source Data -> ${compact} -> Business Output`;
  }

  if (techLine) {
    const tech = techLine
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (tech.length >= 3) {
      return `${tech[0]} -> ${tech[1]} -> ${tech[2]}`;
    }
    if (tech.length === 2) {
      return `${tech[0]} -> ${tech[1]} -> Output`;
    }
    if (tech.length === 1) {
      return `Source Data -> ${tech[0]} -> Output`;
    }
  }

  return "Source Data -> Processing/Orchestration -> Storage/Serving -> Output";
}

async function loadLiveAnswerHistoryMessages(sessionId: string): Promise<
  Array<{
    role: "AI_ASSISTANT";
    messageId: string;
    question: string;
    answer: string;
    timestamp: string;
  }>
> {
  const chunks = await prisma.transcriptChunk.findMany({
    where: {
      sessionId,
      questionGroupId: LIVE_TRANSCRIPT_GROUP_ID,
      speakerType: SpeakerType.ASSISTANT,
      aiAnswer: { not: null },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 80,
    select: {
      id: true,
      questionId: true,
      question: true,
      aiAnswer: true,
      createdAt: true,
    },
  });

  return chunks
    .reverse()
    .map((chunk) => ({
      role: "AI_ASSISTANT" as const,
      messageId: (chunk.questionId || chunk.id).replace(/^live:/, ""),
      question: chunk.question || "",
      answer: chunk.aiAnswer || "",
      timestamp: chunk.createdAt.toISOString(),
    }))
    .filter((entry) => entry.answer.trim().length > 0);
}

/**
 * Maps a session language string to a Prisma Language enum value.
 */
function mapLanguage(lang: string): Language {
  const l = (lang || "").toLowerCase().trim();
  if (l.includes("javascript") || l === "js") return Language.JavaScript;
  if (l.includes("typescript") || l === "ts") return Language.TypeScript;
  if (l.includes("python") || l === "py") return Language.Python;
  if (l === "java") return Language.Java;
  if (l.includes("c++") || l === "cpp" || l.includes("plus plus"))
    return Language.C_Plus_Plus;
  if (l === "c") return Language.C;
  if (l.includes("c#") || l === "csharp" || l.includes("c sharp"))
    return Language.C_Sharp;
  if (l === "go" || l === "golang") return Language.Go;
  return Language.General;
}

/**
 * Maps a job description to a Prisma Industry enum value based on keywords.
 */
function mapIndustry(jobDesc: string): Industry {
  const j = (jobDesc || "").toLowerCase().trim();
  if (
    j.includes("frontend") ||
    j.includes("backend") ||
    j.includes("full stack") ||
    j.includes("fullstack") ||
    j.includes("react") ||
    j.includes("node") ||
    j.includes("web")
  )
    return Industry.Full_Stack;
  if (
    j.includes("data") ||
    j.includes("ml") ||
    j.includes("machine learning") ||
    j.includes("ai")
  )
    return Industry.Data_Science;
  if (
    j.includes("devops") ||
    j.includes("sre") ||
    j.includes("docker") ||
    j.includes("kubernetes") ||
    j.includes("infra")
  )
    return Industry.DevOps;
  if (
    j.includes("mobile") ||
    j.includes("ios") ||
    j.includes("android") ||
    j.includes("flutter")
  )
    return Industry.Mobile;
  if (
    j.includes("aws") ||
    j.includes("azure") ||
    j.includes("gcp") ||
    j.includes("cloud")
  )
    return Industry.Cloud;
  if (j.includes("architect") || j.includes("system design"))
    return Industry.System_Design;
  return Industry.DSA;
}

/**
 * Creates a new interview session.
 */
export async function createSession(data: CreateSessionData) {
  // ── Single-session enforcement ──────────────────────────────────────────────
  const openSession = await prisma.session.findFirst({
    where: {
      userId: data.userId,
      status: { in: [SessionStatus.ACTIVE, SessionStatus.PAUSED, SessionStatus.DISCONNECTED] },
    },
    select: { id: true, status: true },
  });
  if (openSession) {
    throw new AppError(409, `ACTIVE_SESSION_EXISTS:${openSession.id}`);
  }
  const projectSelection = resolveSessionProjectSelection({
    projectIds: data.projectIds,
    primaryProjectId: data.primaryProjectId,
  });

  let finalCompanyId = "";

  if (data.companyName) {
    // Generate a basic slug
    let baseSlug = data.companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "");
    if (!baseSlug) baseSlug = `company-${Date.now()}`;

    // Find or create the company
    let company = await prisma.company.findFirst({
      where: { name: { equals: data.companyName, mode: "insensitive" } },
    });

    if (!company) {
      // Ensure slug uniqueness simple fallback
      const existingSlug = await prisma.company.findUnique({
        where: { slug: baseSlug },
      });
      if (existingSlug) {
        baseSlug = `${baseSlug}-${Math.floor(Math.random() * 10000)}`;
      }

      company = await prisma.company.create({
        data: {
          name: data.companyName,
          slug: baseSlug,
        },
      });
    }

    finalCompanyId = company.id;
  }

  const session = await prisma.session.create({
    data: {
      userId: data.userId,
      companyName: data.companyName || "",
      companyId: finalCompanyId,
      jobDescription: data.jobDescription || "",
      resumeId: data.resumeId || "",
      documentId: data.DocumentId || "",
      language: data.language || "",
      simpleLanguage: data.simpleLanguage,
      extraContext: data.extraContext || "",
      autoGenerateResponse: data.autoGenerateResponse,
      saveTranscription: data.saveTranscription,
      mode: data.mode,
      free: data.free,
      status: SessionStatus.PRE_CHECK,
      projectIds: projectSelection.projectIds,
      primaryProjectId: projectSelection.primaryProjectId,
    },
  });

  enqueueCandidateDigestWarmup(session.id).catch((error) => {
    console.warn("[candidate-digest] create-session warmup enqueue failed", {
      sessionId: session.id,
      error,
    });
  });

  return session;
}

/**
 * Returns all sessions for a specific user with optional filters.
 */
export async function getSessionsByUser(
  userId: string,
  filters?: SessionListFilters,
) {
  const cacheKey = createSessionListCacheKey(userId, filters);
  const existing = sessionListInFlight.get(cacheKey);
  if (existing) {
    return existing;
  }

  const where = buildSessionListWhere(userId, filters);
  const query = prisma.session.findMany({
    where,
    select: SESSION_LIST_SELECT,
    orderBy: { createdAt: "desc" },
  });

  sessionListInFlight.set(cacheKey, query);

  try {
    return await query;
  } finally {
    sessionListInFlight.delete(cacheKey);
  }
}

/**
 * Returns a specific session by ID.
 */
export async function getSessionById(id: string) {
  return prisma.session.findUnique({
    where: { id },
    include: { feedback: true },
  });
}

/**
 * Deletes a session by ID.
 * Only PRE_CHECK sessions can be deleted (never activated, no credits at risk).
 */
const DELETABLE_STATUSES: SessionStatus[] = [
  SessionStatus.PRE_CHECK,
  SessionStatus.COMPLETED,
  SessionStatus.ABANDONED,
  SessionStatus.FORCE_ENDED,
  SessionStatus.AUTO_ENDED,
  SessionStatus.CREDIT_EXHAUSTED,
  SessionStatus.DISCONNECTED,
];

export async function deleteSession(id: string) {
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) throw new AppError(404, "Session not found");
  if (!DELETABLE_STATUSES.includes(session.status)) {
    throw new AppError(409, "Cannot delete an active or in-progress session. End the session first.");
  }
  return prisma.session.delete({
    where: { id },
  });
}

/**
 * Activates a session (sets status to ACTIVE, computes credit cap, records start time).
 * Enforces single-active-session per user — throws 409 ACTIVE_SESSION_EXISTS if blocked.
 * Runs inside a $transaction for race-condition safety.
 */
export async function activateSession(
  id: string,
  settings?: { language?: string; simpleLanguage?: boolean },
) {
  // ── Pre-flight reads (outside transaction to avoid timeout) ─────────────────
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) throw new AppError(404, "Session not found");

  const hasLanguageOverride =
    typeof settings?.language === "string" &&
    settings.language.trim().length > 0 &&
    settings.language.trim() !== session.language;
  const hasSimpleLanguageOverride =
    typeof settings?.simpleLanguage === "boolean" &&
    settings.simpleLanguage !== session.simpleLanguage;

  const settingsUpdate: Prisma.SessionUpdateInput = {
    ...(hasLanguageOverride ? { language: settings!.language!.trim() } : {}),
    ...(hasSimpleLanguageOverride
      ? { simpleLanguage: settings!.simpleLanguage! }
      : {}),
  };

  // Idempotent — already ACTIVE (reconnect case)
  if (session.status === SessionStatus.ACTIVE) {
    if (Object.keys(settingsUpdate).length === 0) return session;
    return prisma.session.update({
      where: { id },
      data: settingsUpdate,
    });
  }

  // Allow DISCONNECTED → ACTIVE (reconnection within grace window)
  if (
    session.status !== SessionStatus.PRE_CHECK &&
    session.status !== SessionStatus.DISCONNECTED
  ) {
    throw new AppError(
      409,
      `Cannot activate session in status ${session.status}`,
    );
  }

  // Compute credit cap outside the transaction — this is a slow async call
  // that must not run inside an interactive tx due to the 5 s default timeout.
  let maxAllowedMinutes: number | null = null;
  let bracketConfigSnapshot: unknown = null;

  if (!session.free) {
    const balance = await prisma.userCreditBalance.findUnique({
      where: { userId: session.userId },
    });
    if (!balance) throw new AppError(402, "INSUFFICIENT_CREDITS");

    const available = new Prisma.Decimal(balance.totalAvailable.toString());
    const { maxMinutes, snapshot } =
      await creditsService.computeMaxAllowedMinutes(available);
    maxAllowedMinutes = maxMinutes;
    bracketConfigSnapshot = snapshot;
  }

  // ── Atomic state transition ─────────────────────────────────────────────────
  return prisma.$transaction(async (tx) => {
    // Re-read inside tx to guard against concurrent activations
    const current = await tx.session.findUnique({ where: { id } });
    if (!current) throw new AppError(404, "Session not found");

    // Re-check status — another request may have raced
    if (current.status === SessionStatus.ACTIVE) return current;
    if (
      current.status !== SessionStatus.PRE_CHECK &&
      current.status !== SessionStatus.DISCONNECTED
    ) {
      throw new AppError(
        409,
        `Cannot activate session in status ${current.status}`,
      );
    }

    // Single-session enforcement — atomic check inside tx
    const conflict = await tx.session.findFirst({
      where: {
        userId: current.userId,
        id: { not: id },
        status: {
          in: [
            SessionStatus.ACTIVE,
            SessionStatus.PAUSED,
            SessionStatus.DISCONNECTED,
          ],
        },
      },
      select: { id: true, status: true },
    });
    if (conflict) {
      throw new AppError(409, `ACTIVE_SESSION_EXISTS:${conflict.id}`);
    }

    const now = new Date();
    return tx.session.update({
      where: { id },
      data: {
        ...settingsUpdate,
        status: SessionStatus.ACTIVE,
        ...(current.status === SessionStatus.PRE_CHECK
          ? { startedAt: now }
          : {}),
        disconnectedAt: null,
        lastHeartbeatAt: now,
        creditsHeld: new Prisma.Decimal(0),
        maxAllowedMinutes,
        bracketConfigSnapshot: bracketConfigSnapshot as any,
      },
    });
  });
}

/**
 * Deactivates a session (sets status to COMPLETING, records end time, enqueues deduction job).
 */
export async function deactivateSession(
  id: string,
  aiUsage?: number | null,
  transcript?: string,
) {
  const usageCount =
    typeof aiUsage === "number" ? aiUsage : parseInt(aiUsage as any, 10);

  const { session, didTransition } = await prisma.$transaction(async (tx) => {
    const s = await tx.session.findUnique({ where: { id } });
    if (!s) throw new Error("Session not found");

    // Idempotency guard — already closed or in-flight
    if (
      s.status === SessionStatus.COMPLETED ||
      s.status === SessionStatus.COMPLETING ||
      s.status === SessionStatus.CREDIT_EXHAUSTED ||
      s.status === SessionStatus.FORCE_ENDED
    ) {
      return { session: s, didTransition: false };
    }

    if (
      s.status !== SessionStatus.ACTIVE &&
      s.status !== SessionStatus.PAUSED &&
      s.status !== SessionStatus.DISCONNECTED
    ) {
      throw new AppError(
        409,
        `Cannot deactivate session in status ${s.status}`,
      );
    }

    const updated = await tx.session.update({
      where: { id },
      data: {
        status: SessionStatus.COMPLETING,
        endedAt: new Date(),
        ...(!isNaN(usageCount) && usageCount > 0
          ? { aiUsage: { increment: usageCount } }
          : {}),
      },
    });
    return { session: updated, didTransition: true };
  });

  if (session.saveTranscription !== false) {
    await forceFlushSessionTranscript(id).catch((error) => {
      console.error("[live-transcript-flush] deactivate flush failed", { sessionId: id, error });
    });
  }

  // Enqueue deduction job only when we actually transitioned to COMPLETING
  if (didTransition && session.status === SessionStatus.COMPLETING) {
    if (session.bracketConfigSnapshot) {
      await creditDeductionQueue.add("credit-deduction", {
        sessionId: id,
        userId: session.userId,
      });
    } else {
      // Free session — mark COMPLETED synchronously.
      // Clear both transcript and messages when the user opted out of saving.
      await prisma.session.update({
        where: { id },
        data: {
          status: SessionStatus.COMPLETED,
          ...(session.saveTranscription === false
            ? { transcript: [], messages: [] }
            : {}),
        },
      });
    }
  }

  return session;
}

/**
 * Abandons a stale ACTIVE or PAUSED session — called by session-watchdog when
 * no heartbeat was received. No credits are charged (watchdog uses DISCONNECTED →
 * AUTO_ENDED path instead for billing; ABANDONED is reserved for sessions that
 * never left PRE_CHECK or were force-abandoned).
 */
export async function abandonStaleSession(
  sessionId: string,
  _userId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) return;

    // Only handle sessions that are still open
    if (
      session.status !== SessionStatus.ACTIVE &&
      session.status !== SessionStatus.PAUSED
    ) {
      return;
    }

    await tx.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.ABANDONED,
        endedAt: new Date(),
        creditsDeducted: new Prisma.Decimal(0),
        deductionReason: DeductionReason.ABANDONED,
        // Honour the user's transcript preference even on abandoned sessions.
        // Clear both transcript and messages to fully respect ephemeral mode.
        ...(session.saveTranscription === false
          ? { transcript: [], messages: [] }
          : {}),
      },
    });
  });

  await forceFlushSessionTranscript(sessionId).catch((error) => {
    console.error("[live-transcript-flush] abandon flush failed", { sessionId, error });
  });

  console.log(`[watchdog] Session ${sessionId} abandoned — hold released, 0 credits charged.`);
}

/**
 * Force-closes a session as CREDIT_EXHAUSTED and enqueues a deduction job with the exhausted flag.
 * Called by the heartbeat endpoint or session watchdog.
 * @param sessionId Session UUID
 * @param dbUserId  Internal (DB) user UUID — not Clerk ID
 */
export async function creditExhaustionClose(
  sessionId: string,
  dbUserId: string,
) {
  await prisma.$transaction(async (tx) => {
    const s = await tx.session.findUnique({ where: { id: sessionId } });
    if (!s || s.status !== SessionStatus.ACTIVE) return;

    await tx.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.CREDIT_EXHAUSTED,
        endedAt: new Date(),
        creditExhaustedAt: new Date(),
      },
    });
  });

  await forceFlushSessionTranscript(sessionId).catch((error) => {
    console.error("[live-transcript-flush] credit-exhaustion flush failed", { sessionId, error });
  });

  // Notify frontend via SSE
  const { sseManager } = await import("../../shared/lib/sse");
  sseManager.notify(sessionId, "SESSION_CLOSED", {
    reason: "CREDIT_EXHAUSTED",
    sessionId,
  });

  await creditDeductionQueue.add("credit-deduction", {
    sessionId,
    userId: dbUserId,
    isExhausted: true,
  });
}

/**
 * Aggregates all available context for a session (JD, Resume, Documents, Instructions).
 */
export async function getSessionFullContext(sessionId: string, query?: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { company: true },
  });

  if (!session) return null;

  // 1. Fetch resume: use session-specific resumeId only
  let resumeContextText = "No resume provided.";
  if (session.resumeId) {
    const resume = await getUnifiedResumeContext(session.resumeId)
      .catch((e) => { console.warn("Failed to fetch session resume:", e); return null; });

    if (resume) {
      const sourceLabel = resume.source === "builder" ? "Built-in Wizard" : "Uploaded";
      let rText = `━━━ RESUME (${sourceLabel}): ${resume.filename} ━━━\n${resume.resumeContext || "No text parsed from this resume."}`;
      if (resume.atsAnalysis) {
        const ats = resume.atsAnalysis;
        rText += `\n\n[Resume ATS Analysis]:\nScore: ${ats.score}/100\nSummary: ${ats.summary}\nStrengths:\n${ats.strengths.map(s => `  • ${s}`).join("\n")}\nWeaknesses:\n${ats.weaknesses.map(w => `  • ${w}`).join("\n")}\nSuggestions:\n${ats.suggestions.map(sg => `  • ${sg}`).join("\n")}`;
      }
      resumeContextText = rText;
    }
  }

  // 2. Fetch document: use session-specific documentId only
  let documentText = "None provided.";
  if (session.documentId) {
    const document = await prisma.document.findUnique({
      where: { id: session.documentId }
    }).catch((e) => { console.warn("Failed to fetch session document:", e); return null; });

    if (document) {
      try {
        const ext = path.extname(document.path).toLowerCase();
        const text = await documentService.extractTextFromFile(document.path, ext);
        if (text) {
          // Truncate document text to 2000 chars max to control token usage
          const truncatedText = text.length > 2000 ? text.substring(0, 2000) + "... (truncated)" : text;
          documentText = `━━━ DOCUMENT: ${document.filename} (Uploaded: ${document.uploadedAt.toISOString().split("T")[0]}) ━━━\n${truncatedText}`;
        }
      } catch (e) {
        console.warn(`Failed to extract text from document ${document.filename}:`, e);
      }
    }
  }

  // 3. Fetch projects: use session-specific projectIds only
  const projectIds = uniqNonEmptyStrings(
    Array.isArray(session.projectIds) ? (session.projectIds as unknown[]) : [],
  );
  const primaryProjectId =
    typeof (session as any).primaryProjectId === "string" &&
    (session as any).primaryProjectId.trim().length > 0
      ? (session as any).primaryProjectId.trim()
      : (projectIds[0] ?? null);
  let projectRecords: any[] = [];
  if (projectIds.length > 0) {
    const fetched = await prisma.project.findMany({
      where: { id: { in: projectIds } }
    }).catch((e) => { console.warn("Failed to fetch session projects:", e); return []; });
    projectRecords = orderProjectRecordsBySelection(
      fetched,
      projectIds,
      primaryProjectId,
    );
  }

  // Serialize selected AI projects into a rich, readable context string.
  let projectsText = "";
  if (projectRecords.length > 0) {
    projectsText = projectRecords
      .map((pr, selectedIdx) => {
        const items = Array.isArray(pr.projects) ? (pr.projects as any[]) : [];
        return items
          .map((p: any, idx: number) => {
            const header = p.projectHeader || {};
            const tag =
              selectedIdx === 0
                ? "PRIMARY PROJECT"
                : "OPTIONAL PROJECT";
            const lines: string[] = [
              `━━━ ${tag} ${selectedIdx + 1}.${idx + 1}: ${header.title || "Untitled"} ━━━`,
              header.tagline ? `Tagline: ${header.tagline}` : "",
              header.domain ? `Domain: ${header.domain}` : "",
              header.role ? `Your Role: ${header.role}` : "",
              header.duration ? `Duration: ${header.duration}` : "",
              header.teamSize ? `Team: ${header.teamSize}` : "",
            ].filter(Boolean);

            const sections: any[] = Array.isArray(p.sections) ? p.sections : [];
            for (const sec of sections) {
              if (!sec?.type || !sec?.content) continue;
              const sectionTitle = `\n[${sec.title || sec.key}]`;

              switch (sec.type) {
                case "bullets":
                  if (Array.isArray(sec.content) && sec.content.length) {
                    lines.push(sectionTitle);
                    lines.push(...(sec.content as string[]).map((b) => `  • ${b}`));
                  }
                  break;

                case "narrative":
                  if (typeof sec.content === "string" && sec.content.trim()) {
                    lines.push(sectionTitle);
                    lines.push(`  ${sec.content.trim()}`);
                  }
                  break;

                case "how_to_explain": {
                  const h = sec.content as any;
                  lines.push(sectionTitle);
                  if (h?.elevatorPitch) lines.push(`  Elevator Pitch: ${h.elevatorPitch}`);
                  if (h?.detailedExplanation) lines.push(`  Detailed: ${h.detailedExplanation}`);
                  break;
                }

                case "thirty_second_summary": {
                  const t = sec.content as any;
                  lines.push(sectionTitle);
                  if (t?.hook) lines.push(`  Hook: ${t.hook}`);
                  if (Array.isArray(t?.mainPoints)) lines.push(...(t.mainPoints as string[]).map((pt: string) => `  • ${pt}`));
                  if (t?.closingLine) lines.push(`  Closing: ${t.closingLine}`);
                  break;
                }

                case "star_story": {
                  const s = sec.content as any;
                  lines.push(sectionTitle);
                  if (s?.situation) lines.push(`  Situation: ${s.situation}`);
                  if (s?.task) lines.push(`  Task: ${s.task}`);
                  if (s?.action) lines.push(`  Action: ${s.action}`);
                  if (s?.result) lines.push(`  Result: ${s.result}`);
                  break;
                }

                case "metrics":
                  if (Array.isArray(sec.content) && sec.content.length) {
                    lines.push(sectionTitle);
                    lines.push(...(sec.content as any[]).map((m) =>
                      `  • ${m.metric}: ${m.value}${m.description ? ` — ${m.description}` : ""}${m.before ? ` (before: ${m.before}, after: ${m.after || m.value})` : ""}`,
                    ));
                  }
                  break;

                case "tech_tags":
                  if (Array.isArray(sec.content) && sec.content.length) {
                    lines.push(sectionTitle);
                    lines.push(...(sec.content as any[]).map((cat) =>
                      `  ${cat.category}: ${(cat.tags || []).join(", ")}`,
                    ));
                  }
                  break;

                case "challenge_cards":
                  if (Array.isArray(sec.content) && sec.content.length) {
                    lines.push(sectionTitle);
                    lines.push(...(sec.content as any[]).map((c) =>
                      `  • Challenge: ${c.challenge} → Solution: ${c.solution}`,
                    ));
                  }
                  break;

                case "key_value_pairs":
                  if (Array.isArray(sec.content) && sec.content.length) {
                    lines.push(sectionTitle);
                    lines.push(...(sec.content as any[]).map((kv) => `  ${kv.key}: ${kv.value}`));
                  }
                  break;

                case "steps":
                  if (Array.isArray(sec.content) && sec.content.length) {
                    lines.push(sectionTitle);
                    lines.push(...(sec.content as any[]).map((s, i) => `  ${i + 1}. ${s.step}: ${s.description}`));
                  }
                  break;

                default:
                  break;
              }
            }
            return lines.join("\n");
          })
          .join("\n\n");
      })
      .join("\n\n════════════════════════════════════════\n\n");
  }

  // 4. Fetch recent Q&A history for conversation context.
  const messages = Array.isArray(session.messages)
    ? (session.messages as any[])
    : [];
  const qaMessages = messages
    .filter((m) => m.role === "AI_ASSISTANT" && m.question && m.answer)
    .slice(-8); // Keep last 8 answered Q&A pairs for follow-up context
  const recentHistory =
    qaMessages.length > 0
      ? qaMessages
        .map(
          (m, i) =>
            `Turn ${i + 1} (Interviewer asked):\n  Q: ${m.question.trim()}\n  A: ${m.answer.trim()}`,
        )
        .join("\n\n")
      : "";

  // 5. Fetch past sessions and user Q&As for historical context
  const pastSessions = await prisma.session.findMany({
    where: {
      userId: session.userId,
      id: { not: sessionId }
    },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: {
      companyName: true,
      jobDescription: true,
      messages: true,
      createdAt: true
    }
  }).catch((e) => { console.warn("Failed to fetch past sessions:", e); return []; });

  let pastSessionsContext = "";
  if (pastSessions.length > 0) {
    pastSessionsContext = pastSessions.map((ps, idx) => {
      const msgs = Array.isArray(ps.messages) ? (ps.messages as any[]) : [];
      const qaPairs = msgs
        .filter(m => m.role === "AI_ASSISTANT" && m.question && m.answer)
        .slice(-2) // last 2 Q&As
        .map(m => `  Q: ${m.question.trim()}\n  A: ${m.answer.trim()}`)
        .join("\n\n");
      return `[Past Session ${idx + 1} at ${ps.companyName || "Unknown Company"} - ${ps.jobDescription || "General"} on ${ps.createdAt.toISOString().split("T")[0]}]:\n${qaPairs || "  No Q&As recorded."}`;
    }).join("\n\n---\n\n");
  }

  const userQAs = await prisma.qA.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      ques: true,
      answer: true,
      difficulty: true,
      industry: true
    }
  }).catch((e) => { console.warn("Failed to fetch user QAs:", e); return []; });

  let pastQAsContext = "";
  if (userQAs.length > 0) {
    pastQAsContext = userQAs
      .map(qa => `  Q [${qa.difficulty}/${qa.industry}]: ${qa.ques}\n  A: ${qa.answer || "No answer recorded."}`)
      .join("\n\n");
  }

  let combinedPreviousContext = "";
  if (pastSessionsContext) {
    combinedPreviousContext += `━━━ PAST INTERVIEW SESSIONS ━━━\n${pastSessionsContext}\n\n`;
  }
  if (pastQAsContext) {
    combinedPreviousContext += `━━━ HISTORICAL Q&A ARCHIVE ━━━\n${pastQAsContext}`;
  }

  let historyAndPastContext = recentHistory || "No previous interactions in this session.";
  if (combinedPreviousContext) {
    historyAndPastContext += `\n\n════════════════════════════════════════\n${combinedPreviousContext}`;
  }

  // 6. Semantic RAG Search over all user transcript chunks
  let vectorContext = "";
  if (query) {
    try {
      const { RagService } = require("../ask-ai/rag.service");
      const ragService = new RagService();
      let chunks = await ragService.retrieveContext(sessionId, session.userId, query);

      // DISABLED cross-session fallback to prevent massive token usage
      // Only use chunks from current session to control costs
      // if ((!chunks || chunks.length === 0) && ragService.embeddingService) {
      //   const { embedding } = await ragService.embeddingService.generateEmbedding(query);
      //   const embeddingStr = `[${embedding.join(",")}]`;
      //   const { AI_CONFIG } = require("../../config/ai.config");
      //   
      //   const allUserChunks = await prisma.$queryRawUnsafe<any[]>(
      //     `SELECT 
      //       id, question, "aiAnswer", content, technologies,
      //       (embedding <=> $1::vector) as distance
      //     FROM "TranscriptChunk"
      //     WHERE "userId" = $2
      //     ORDER BY distance ASC
      //     LIMIT $3`,
      //     embeddingStr,
      //     session.userId,
      //     AI_CONFIG?.rag?.topK || 4
      //   ).catch(() => []);
      //   
      //   chunks = allUserChunks.filter((r: any) => r.distance < 0.6);
      // }

      if (chunks && chunks.length > 0) {
        vectorContext = chunks
          .map((c: any, idx: number) => `[Semantic Chunk Ref ${idx + 1}]:\nQuestion: ${c.question}\nAnswer: ${c.aiAnswer}\nTranscript excerpt: ${c.content}`)
          .join("\n\n---\n\n");
      }
    } catch (e) {
      console.warn("Failed to fetch vector context:", e);
    }
  }

  const hasSelectedProjects = projectIds.length > 0;
  const isProjectQuestion = isProjectExperienceQuestion(query);
  return {
    company: session.company?.name || session.companyName || "Unknown",
    role: session.jobDescription || "Interviewee",
    language: session.language || "General",
    simpleLanguage: session.simpleLanguage,
    instructions: session.extraContext || "None",
    resume: resumeContextText,
    document: documentText,
    projects: projectsText || null,
    history: historyAndPastContext,
    vectorContext: vectorContext || null,
    hasSelectedProjects,
    projectPriorityMode: "project_questions_only",
    isProjectQuestion,
  };
}

/**
 * Shared helper to handle AI stream generation and post-processing (saving to DB).
 */
function processAIStream(
  result: any,
  session: any,
  sessionId: string,
  fallbackQuestion: string,
  contextForCall?: any,
  targetModel?: string,
  snapshotId?: string,
  isRegenerate: boolean = false,
  authoritativeQuestion?: string,
  questionMeta?: QuestionMeta,
  orchestration?: ContextOrchestrationResult,
) {
  const segmentMarker = /\n?={3,}NEXT_QUESTION={3,}\n?/i;
  const rewriteFirstQuestionBlock = (text: string): string => {
    if (!authoritativeQuestion?.trim()) return text;
    const questionLine = authoritativeQuestion.replace(/\s+/g, " ").trim();
    if (!questionLine) return text;
    const rewritten = text.replace(
      /(\*?\*?QUESTION:\*?\*?\s*)([\s\S]*?)(\s*\*?\*?ANSWER:\*?\*?)/i,
      (_full, prefix, _questionBody, suffix) =>
        `${String(prefix).trimEnd()}\n${questionLine}\n\n${String(suffix).trimStart()}`,
    );
    return rewritten;
  };
  const extractPairs = (text: string) => {
    const segments = text
      .split(segmentMarker)
      .map((segment) => segment.trim())
      .filter(Boolean);

    const sourceSegments = segments.length > 0 ? segments : [text.trim()];

    return sourceSegments
      .map((segment) => {
        const questionMatch = segment.match(
          /\*?\*?QUESTION:\*?\*?\s*([\s\S]*?)\s*\*?\*?ANSWER:/i,
        );
        const answerMatch = segment.match(/\*?\*?ANSWER:\*?\*?\s*([\s\S]*)/i);
        const question =
          questionMatch?.[1]
            ?.trim()
            ?.replace(
              /^(\d+[\s.)-]+\s*|Question\s*\d+[:\s-]*|Q\d+[:\s-]*)/i,
              "",
            ) || fallbackQuestion;
        const answer = answerMatch?.[1]?.trim() || segment;

        return { question, answer };
      })
      .filter((pair) => pair.answer);
  };

  async function* streamGenerator() {
    let fullResponse = "";
    const modelCallStartedAt = Date.now();
    let firstTokenLogged = false;

    if (questionMeta) {
      yield { text: `===QUESTION_META=${JSON.stringify(questionMeta)}===\n` };
    }

    for await (const delta of result.getTextStream()) {
      if (delta) {
        if (!firstTokenLogged) {
          firstTokenLogged = true;
          const firstTokenMs = Date.now() - modelCallStartedAt;
          console.log("[AI Stream][Timing][BE]", {
            sessionId,
            firstTokenMs,
            model: targetModel || "default",
          });
          if (firstTokenMs > 2500) {
            console.warn("[AI Stream][first-token-slow]", {
              sessionId,
              firstTokenMs,
              model: targetModel || "default",
            });
          }
        }
        fullResponse += delta;
        yield { text: delta };
      }
    }

    const finalResponse = rewriteFirstQuestionBlock(fullResponse || (await result.getText()));

    if (snapshotId) {
      yield { text: `\n===SNAPSHOT_ID=${snapshotId}===` };
    }

    // Post-processing: extract Q&A and persist (fire-and-forget)
    (async () => {
      try {
        const extractedPairs = extractPairs(finalResponse);

        if (extractedPairs.length > 0 && session) {
          // Ephemeral sessions — skip all persistence (QA table + messages).
          // The user opted out of transcript saving; no data should outlive the session.
          if (session.saveTranscription !== false) {
            for (const { question, answer } of extractedPairs) {
              await qaService
                .createQA({
                  userId: session.userId,
                  sessionId,
                  companyId: session.companyId,
                  ques: question,
                  answer,
                  language: mapLanguage(session.language),
                  industry: mapIndustry(session.jobDescription),
                })
                .catch((e) => console.error("Auto-save QA Error:", e));

              if (snapshotId && contextForCall && targetModel && !isRegenerate) {
                const { createGenerationSnapshot } = require("./cie.service");
                await createGenerationSnapshot({
                  id: snapshotId,
                  sessionId,
                  originalQuestionTranscript: question,
                  generatedAnswer: answer,
                  modelUsed: targetModel,
                  context: contextForCall,
                }).catch((e: any) => console.error("createGenerationSnapshot Error:", e));
              }

              if (isRegenerate && snapshotId) {
                await updateMessageAnswer(
                  sessionId,
                  snapshotId,
                  question,
                  answer,
                ).catch((e: any) => console.error("updateMessageAnswer Error:", e));
              } else {
                const appendResult = await appendMessage(
                  sessionId,
                  "AI_ASSISTANT",
                  question,
                  answer,
                  undefined,
                  snapshotId,
                ).catch((e) => console.error("appendMessage Error:", e));
                if (appendResult && orchestration) {
                  const topicTitle =
                    orchestration.questionMeta.topic ||
                    orchestration.reconstructedQuestion.topicId ||
                    "general";
                  const topicKeywords = [
                    ...orchestration.candidateDigest.domainKeywords.slice(0, 12),
                    ...orchestration.reconstructedQuestion.displayQuestion
                      .split(/\W+/)
                      .filter((word) => word.length > 2)
                      .slice(0, 12),
                  ];
                  await writeTurnMemory({
                    sessionId,
                    transcriptChunkId: appendResult.transcriptChunkId,
                    topicId: orchestration.activeTopic?.id,
                    questionRaw: orchestration.reconstructedQuestion.displayQuestion,
                    questionClean: question,
                    answerRaw: answer,
                    saveTranscription: session.saveTranscription !== false,
                  }).catch((e) => console.error("writeTurnMemory Error:", e));
                  await writeTopicMemory({
                    sessionId,
                    question,
                    answer,
                    topicTitle,
                    topicKeywords,
                    saveTranscription: session.saveTranscription !== false,
                  }).catch((e) => console.error("writeTopicMemory Error:", e));
                }
              }
            }
          }
        }
      } catch (e) {
        console.error("Post-processing Error:", e);
      }
    })();
  }
  return streamGenerator();
}

/**
 * Analyzes a provided screenshot within a session context.
 * Uses a single AI call — the model returns QUESTION + ANSWER in one response.
 */
export async function analyzeScreen(
  id: string,
  file: Express.Multer.File,
  aiModel?: string,
  liveContextMetadata?: AIAnswerLiveContextMetadata,
) {
  // Skip recompression if the frontend already sent a pre-compressed JPEG (<= 600 KB).
  // Otherwise apply sharp to enforce a safe size cap for the LLM vision API.
  const isPreCompressed = file.mimetype === "image/jpeg" && file.size <= 600 * 1024;
  const compressPromise = isPreCompressed
    ? Promise.resolve(file.buffer)
    : sharp(file.buffer)
      .resize({ width: 1024 })
      .jpeg({ quality: 65 })
      .toBuffer()
      .catch((err) => { console.error("Sharp compression error:", err); throw err; });

  const screenQuestionRaw =
    liveContextMetadata?.activeQuestionDetection?.cleanedQuestion?.trim() ||
    liveContextMetadata?.activeQuestionDetection?.activeQuestion?.trim() ||
    (liveContextMetadata?.recentTranscriptWindow || []).join(" ").trim() ||
    "screen visible interview question";
  const guardedScreenQuestion = guardCurrentQuestion({
    resolvedQuestion: screenQuestionRaw,
    recentTranscriptWindow: liveContextMetadata?.recentTranscriptWindow,
  });
  const screenContextQuestion = normalizeTranscriptForQuestionDetection(
    guardedScreenQuestion.resolvedCurrentQuestion || screenQuestionRaw,
  );
  const sessionPromise = prisma.session.findUnique({ where: { id }, include: { company: true } });
  const contextBuildStartedAt = Date.now();
  const contextPromise = sessionPromise.then((loadedSession) =>
    buildOptimizedContext(id, screenContextQuestion, 1800, loadedSession, {
      complexity: "simple_contextual",
      disableProjectPriority: true,
      contextMode: "live",
    }),
  );

  const [compressed, session, context] = await Promise.all([
    compressPromise,
    sessionPromise,
    contextPromise,
  ]);

  if (!session) {
    throw new Error("Session not found");
  }
  const contextBuildMs = Date.now() - contextBuildStartedAt;
  if (contextBuildMs > 500) {
    console.warn("[Analyze Screen][context-slow]", { sessionId: id, contextBuildMs });
  }

  try {
    const targetModel = resolveModelId(aiModel) || model;
    // ── Full Prompt Budget Accounting (screen analysis) ──────────────────
    const screenSystemPrompt = buildScreenSystemMessage(context);
    const priorAnswersBlock =
      Array.isArray(liveContextMetadata?.previousAiAnswers) &&
      liveContextMetadata.previousAiAnswers.length > 0
        ? `\n\nRecent AI context:\n${liveContextMetadata.previousAiAnswers
            .slice(-2)
            .map((entry, index) => {
              const question = (entry.question || "").trim();
              const answer = (entry.answer || "").trim().slice(0, 700);
              return question
                ? `- Prior ${index + 1} Q: ${question}\n  A: ${answer}`
                : `- Prior ${index + 1} A: ${answer}`;
            })
            .join("\n")}`
        : "";
    const transcriptContextBlock =
      liveContextMetadata?.recentTranscriptWindow?.length
        ? `\n\nRecent transcript context:\n${liveContextMetadata.recentTranscriptWindow
            .slice(-20)
            .join("\n")}`
        : "";
    const questionContextBlock = screenContextQuestion
      ? `\n\nCurrent interview question context:\n${screenContextQuestion}`
      : "";
    const screenUserText = `${buildScreenAnalysisMessage(context)}${questionContextBlock}${transcriptContextBlock}${priorAnswersBlock}`;
    const screenSystemTokens = estimatePromptTokensForLog(screenSystemPrompt);
    const screenUserTokens = estimatePromptTokensForLog(screenUserText);
    console.log(`[CIE] Screen analysis prompt | system: ${screenSystemTokens}t | user: ${screenUserTokens}t | total: ${screenSystemTokens + screenUserTokens}t | complexity: ${context?.complexity || 'unknown'}`);
    console.log("[Analyze Screen][Timing][BE]", {
      sessionId: id,
      contextBuildMs,
      questionLength: screenContextQuestion.length,
      recentTranscriptWindowCount:
        liveContextMetadata?.recentTranscriptWindow?.length || 0,
      previousAiAnswersCount:
        liveContextMetadata?.previousAiAnswers?.length || 0,
    });

    const result = ai.callModel({
      model: targetModel,
      maxOutputTokens: resolveScreenMaxOutputTokens(),
      provider: latencyOptimizedProvider as any,
      store: false,
      sessionId: id,
      input: [
        {
          role: "system",
          type: "message",
          content: screenSystemPrompt,
        } as any,
        {
          role: "user",
          type: "message",
          content: [
            {
              type: "input_text",
              text: screenUserText,
            },
            {
              type: "input_image",
              detail: "auto",
              imageUrl: `data:image/jpeg;base64,${compressed.toString("base64")}`,
            },
          ] as any,
        },
      ],
    });

    return processAIStream(result, session, id, "(question from screenshot)");
  } catch (err: any) {
    console.error("OpenRouter Error (analyzeScreen):", err);
    if (err.status === 429 || err.statusCode === 429) {
      return (async function* () {
        yield {
          text: "AI is temporarily rate-limited. Please wait a moment and try again.",
        };
      })();
    }
    throw err;
  }
}

/**
 * Generates an AI answer based on a transcript and session context.
 * Uses a single AI call — the model returns QUESTION + ANSWER in one response.
 */
export async function getAIAnswer(
  id: string,
  transcript: string,
  isCustomQuery: boolean = false,
  isRegenerate: boolean = false,
  aiModel?: string,
  snapshotId?: string,
  liveContextMetadata?: AIAnswerLiveContextMetadata,
) {
  const session = await prisma.session.findUnique({
    where: { id },
    select: {
      id: true,
      company: true,
      companyId: true,
      companyName: true,
      messages: true,
      jobDescription: true,
      language: true,
      simpleLanguage: true,
      extraContext: true,
      resumeId: true,
      documentId: true,
      projectIds: true,
      primaryProjectId: true,
      userId: true,
      saveTranscription: true,
    },
  });

  if (!session) {
    throw new Error("Session not found");
  }

  let contextForCall: any;
  let targetModel = resolveModelId(aiModel) || model;
  let finalTranscript = transcript;
  let finalSnapshotId = snapshotId;
  let orchestration: ContextOrchestrationResult | undefined;
  const contextBuildStartedAt = Date.now();
  const detection =
    !isRegenerate && liveContextMetadata?.activeQuestionDetection
      ? liveContextMetadata.activeQuestionDetection
      : undefined;

  if (!isRegenerate) {
    orchestration = await orchestrateAIContext({
      sessionId: id,
      resolvedQuestion: finalTranscript,
      metadata: liveContextMetadata,
    });
    finalTranscript = orchestration.decision.questionForLLM;
    if (!orchestration.decision.shouldAnswer) {
      return (async function* () {
        yield {
          text: `===QUESTION_META=${JSON.stringify(orchestration!.questionMeta)}===\n`,
        };
        yield { text: "===NO_NEW_QUESTION===" };
      })();
    }
  }

  finalTranscript = normalizeTranscriptForQuestionDetection(finalTranscript);

  if (isRegenerate && snapshotId) {
    const snapshot = await prisma.answerGenerationSnapshot.findUnique({
      where: { id: snapshotId },
    });

    if (snapshot) {
      finalTranscript = snapshot.originalQuestionTranscript;

      const docText = Array.isArray(snapshot.selectedDocumentContext)
        ? (snapshot.selectedDocumentContext as string[]).join("\n\n")
        : (snapshot.selectedDocumentContext as string || "");

      const projText = Array.isArray(snapshot.selectedProjectContext)
        ? (snapshot.selectedProjectContext as string[]).join("\n\n")
        : (snapshot.selectedProjectContext as string || "");

      const ragText = Array.isArray(snapshot.ragContext)
        ? (snapshot.ragContext as string[]).join("\n\n")
        : (snapshot.ragContext as string || "");

      contextForCall = {
        company: session.company?.name || session.companyName || "Unknown",
        role: session.jobDescription || "Interviewee",
        language: session.language || "General",
        simpleLanguage: session.simpleLanguage,
        instructions: session.extraContext || "None",
        resume: snapshot.selectedResumeContext || "No resume provided.",
        document: docText || "None provided.",
        projects: projText || "No projects provided.",
        history: "No previous interactions in this session.",
        vectorContext: ragText || null,
        hasSelectedProjects:
          Array.isArray(session.projectIds) &&
          (session.projectIds as string[]).length > 0,
        projectPriorityMode: "project_questions_only",
        isProjectQuestion: isProjectExperienceQuestion(finalTranscript),
      };
    } else {
      console.warn(
        `[AI Answer][Regenerate] Snapshot ${snapshotId} not found. Falling back to live session context.`,
      );
      finalSnapshotId = undefined;
      contextForCall = await buildOptimizedContext(id, finalTranscript, undefined, session, {
        contextMode: "live",
      });
      if (!contextForCall) {
        throw new Error("Failed to build context");
      }
    }
  } else {
    contextForCall = await buildOptimizedContext(id, finalTranscript, undefined, session, {
      contextMode: "live",
    });
    if (!contextForCall) {
      throw new Error("Failed to build context");
    }
    if (orchestration) {
      contextForCall = {
        ...contextForCall,
        history: `${orchestration.contextPacket}\n\n${contextForCall.history || ""}`,
      };
    }
    if (!finalSnapshotId) {
      finalSnapshotId = crypto.randomUUID();
    }
  }
  const contextBuildMs = Date.now() - contextBuildStartedAt;
  if (contextBuildMs > 500) {
    console.warn("[AI Answer Debug][context-slow]", { sessionId: id, contextBuildMs });
  }

  try {
    if (process.env.NODE_ENV !== "production") {
      console.log("[AI Answer Debug] CIE snapshot:", {
        resolvedQuestionLength: transcript?.length || 0,
        cieTierSelected: contextForCall?.complexity || "unknown",
        contextBuildMs,
      });
    }
    // ── Full Prompt Budget Accounting ──────────────────────────────────────
    const originalResolvedQuestion = finalTranscript;
    const guard = guardCurrentQuestion({
      resolvedQuestion: originalResolvedQuestion,
      recentTranscriptWindow: liveContextMetadata?.recentTranscriptWindow,
    });
    const liveHistoryMessages = await loadLiveAnswerHistoryMessages(id).catch((error) => {
      console.warn("[AI Answer Debug] failed loading live transcript chunk history", {
        sessionId: id,
        error,
      });
      return [];
    });
    const history = toAnswerHistory(
      liveHistoryMessages.length > 0 ? liveHistoryMessages : (session as any).messages,
    );
    const conversationIntent = classifyConversationIntent(guard.resolvedCurrentQuestion);
    const followup = resolveFollowupTarget({
      question: guard.resolvedCurrentQuestion,
      history,
      selectedAnswerId: liveContextMetadata?.selectedAnswerId,
      selectedAnswerQuestion: liveContextMetadata?.selectedAnswerQuestion,
      selectedAnswerText: liveContextMetadata?.selectedAnswerText,
      selectedAnswerCodeBlocks: liveContextMetadata?.selectedAnswerCodeBlocks,
      selectedAnswerTopic: liveContextMetadata?.selectedAnswerTopic,
    });
    const fallbackDecision = fallbackAISessionDecision({
      currentQuestion: guard.resolvedCurrentQuestion,
      conversationIntent,
      followup,
    });
    const decisionStartedAt = Date.now();
    const shouldUseDeterministicDecision =
      conversationIntent !== "UNKNOWN" ||
      followup.isExplicitFollowupReference ||
      !!followup.target ||
      !!detection?.isFollowUp;
    const aiDecisionResult = shouldUseDeterministicDecision
      ? {
          decision: fallbackDecision,
          fallbackDecisionUsed: true,
          error: "deterministic_live_decision",
        }
      : await decideAISessionState({
          ai,
          model: targetModel,
          provider: latencyOptimizedProvider as any,
          fallback: fallbackDecision,
          timeoutMs: 450,
          input: {
            currentQuestion: guard.resolvedCurrentQuestion,
            recentTranscriptWindow: liveContextMetadata?.recentTranscriptWindow,
            speakerSeparatedTranscript: liveContextMetadata?.speakerSeparatedTranscript,
            activeQuestionDetection: detection,
            previousAiAnswer: liveContextMetadata?.previousAiAnswer,
            previousAiAnswers: liveContextMetadata?.previousAiAnswers,
            previousCodeBlocks: liveContextMetadata?.previousCodeBlocks,
            selectedAnswerId: liveContextMetadata?.selectedAnswerId,
            selectedAnswerQuestion: liveContextMetadata?.selectedAnswerQuestion,
            selectedAnswerText: liveContextMetadata?.selectedAnswerText,
            selectedAnswerTopic: liveContextMetadata?.selectedAnswerTopic,
            answerHistory: toDecisionContextTargets(history),
            deterministic: {
              conversationIntent,
              isExplicitFollowupReference: followup.isExplicitFollowupReference,
              fallbackTargetId: followup.target?.id || null,
              fallbackTargetHasCode: !!followup.target?.codeBlocks?.length,
              fallbackTargetTopic: followup.target?.topic || null,
              reasonForNoTarget: followup.reasonForNoTarget,
            },
          },
        });
    console.log("[AI Answer Debug] decision timing:", {
      sessionId: id,
      decisionMs: Date.now() - decisionStartedAt,
      deterministic: shouldUseDeterministicDecision,
      error: aiDecisionResult.error || null,
    });
    const aiDecision = aiDecisionResult.decision;
    const aiDecisionAuthoritative =
      !aiDecisionResult.fallbackDecisionUsed &&
      aiDecision.confidence >= AI_DECISION_CONFIDENCE_THRESHOLD;
    const aiDetectedFollowup =
      aiDecision.isFollowUp ||
      [
        "FOLLOW_UP",
        "CONTINUE_PREVIOUS",
        "EXPLAIN_CODE",
        "DEBUG_CODE",
        "OPTIMIZE_CODE",
        "SCENARIO_QUESTION",
      ].includes(aiDecision.intent);
    const backendDetectedFollowup = aiDecisionAuthoritative
      ? aiDetectedFollowup
      : followup.isExplicitFollowupReference || isFollowupConversationIntent(conversationIntent);
    const shouldUseFollowupContext = !!detection?.isFollowUp || backendDetectedFollowup;
    const referencedTarget = detection?.referencedHistoryTurnId
      ? history.find((h) => h.id === detection.referencedHistoryTurnId) || null
      : null;
    const topicChanged = !!detection?.topicChanged;
    const aiDecisionTarget = aiDecision.targetAnswerId
      ? history.find((h) => h.id === aiDecision.targetAnswerId) || null
      : null;
    const aiDecisionLatestCodeTarget =
      aiDecisionAuthoritative &&
      aiDecision.requiresPreviousCode &&
      !aiDecisionTarget
        ? [...history].reverse().find((h) => h.codeBlocks.length > 0) || null
        : null;
    const clearAiFreshQuestion =
      aiDecisionAuthoritative &&
      aiDecision.intent === "NEW_QUESTION" &&
      !aiDecision.isFollowUp &&
      aiDecision.contextToUse === "none";
    const effectiveTopicChanged = clearAiFreshQuestion
      ? true
      : aiDecisionAuthoritative && aiDetectedFollowup
        ? false
        : topicChanged;
    const metadataForRequest = isRegenerate
      ? liveContextMetadata
      : shouldUseFollowupContext && !effectiveTopicChanged
      ? liveContextMetadata
      : {
          ...liveContextMetadata,
          // Always preserve previousAiAnswer/previousCodeBlocks so the AI
          // maintains technical continuity regardless of follow-up classification.
          // Only strip the selected-answer bindings that anchor to a specific turn.
          previousAiAnswer: liveContextMetadata?.previousAiAnswer,
          previousCodeBlocks: liveContextMetadata?.previousCodeBlocks,
          selectedAnswerId: undefined,
          selectedAnswerQuestion: undefined,
          selectedAnswerText: undefined,
          selectedAnswerCodeBlocks: undefined,
          selectedAnswerTopic: undefined,
        };
    const questionTopic = deriveTopicFromAnyText(guard.resolvedCurrentQuestion);
    const selectedAnswerTopicForLog =
      liveContextMetadata?.selectedAnswerTopic ||
      deriveTopicFromAnyText(
        `${liveContextMetadata?.selectedAnswerQuestion || ""} ${liveContextMetadata?.selectedAnswerText || ""}`,
      );
    let previousAiAnswerIgnoredReason: string | null = null;
    const metadataAfterPreviousAnswerGuard = { ...(metadataForRequest || {}) };
    if (
      !metadataAfterPreviousAnswerGuard.previousAiAnswer &&
      Array.isArray((metadataAfterPreviousAnswerGuard as any).previousAiAnswers) &&
      (metadataAfterPreviousAnswerGuard as any).previousAiAnswers.length > 0
    ) {
      const latestPreviousAnswer = (metadataAfterPreviousAnswerGuard as any).previousAiAnswers[
        (metadataAfterPreviousAnswerGuard as any).previousAiAnswers.length - 1
      ];
      if (latestPreviousAnswer?.answer) {
        metadataAfterPreviousAnswerGuard.previousAiAnswer = String(
          latestPreviousAnswer.answer,
        ).slice(0, 1000);
      }
      if (
        !metadataAfterPreviousAnswerGuard.previousCodeBlocks &&
        Array.isArray(latestPreviousAnswer?.codeBlocks)
      ) {
        metadataAfterPreviousAnswerGuard.previousCodeBlocks =
          latestPreviousAnswer.codeBlocks
            .slice(0, 2)
            .map((block: unknown) => String(block || "").slice(0, 1500))
            .filter(Boolean);
      }
    }
    if (
      metadataAfterPreviousAnswerGuard.previousAiAnswer &&
      followup.isExplicitFollowupReference
    ) {
      const previousAiAnswerTopic = deriveTopicFromAnyText(
        metadataAfterPreviousAnswerGuard.previousAiAnswer,
      );
      if (
        questionTopic !== "general" &&
        previousAiAnswerTopic !== "general" &&
        previousAiAnswerTopic !== questionTopic
      ) {
        previousAiAnswerIgnoredReason = "topic_mismatch";
        metadataAfterPreviousAnswerGuard.previousAiAnswer = undefined;
        metadataAfterPreviousAnswerGuard.previousCodeBlocks = undefined;
      }
    }
    const hasExplicitReference = !!detection?.referencedHistoryTurnId;
    const selectedTargetForRequest =
      isRegenerate && followup.target
      ? followup.target
      : effectiveTopicChanged
      ? null
      : shouldUseFollowupContext && aiDecisionAuthoritative && aiDecisionTarget
      ? aiDecisionTarget
      : shouldUseFollowupContext && aiDecisionLatestCodeTarget
      ? aiDecisionLatestCodeTarget
      : shouldUseFollowupContext && hasExplicitReference && referencedTarget
      ? referencedTarget
      : shouldUseFollowupContext && !hasExplicitReference
      ? followup.target
      : null;
    const effectiveMetadata = buildEffectiveLiveContextMetadata({
      metadata: metadataAfterPreviousAnswerGuard,
      question: guard.resolvedCurrentQuestion,
      selectedTarget: selectedTargetForRequest,
    });
    const selectedCodeContext = selectTargetCodeContext(selectedTargetForRequest);
    const hasAnyRecentCodeHistory = history.some((entry) => entry.codeBlocks.length > 0);

    const systemPrompt = buildSystemMessage(contextForCall);
    const baseUserMessage = buildUserMessage(
      guard.resolvedCurrentQuestion,
      isCustomQuery,
      isRegenerate,
      contextForCall,
    );
    const policy = buildRequestScopedPolicy({
      question: guard.resolvedCurrentQuestion,
      metadata: effectiveMetadata,
      cieComplexity: contextForCall?.complexity,
      aiDecision,
    });
    const codeFollowupConstraint =
      (followup.isExplicitFollowupReference ||
        (aiDecisionAuthoritative && aiDecision.requiresPreviousCode)) &&
      (isCodeFollowupQuestion(guard.resolvedCurrentQuestion) || aiDecision.requiresPreviousCode) &&
      selectedCodeContext.codeBlocks.length > 0
        ? "\n- Answer ONLY using the selected prior answer/code as the follow-up target. Do not substitute resume/project context unless user explicitly asks for experience."
        : "";
    const selectedAnswerExcerptBlock =
      (followup.isExplicitFollowupReference ||
        (aiDecisionAuthoritative && aiDecision.isFollowUp) ||
        isRegenerate) &&
      !(isCodeFollowupQuestion(guard.resolvedCurrentQuestion) || aiDecision.requiresPreviousCode) &&
      selectedTargetForRequest?.answer?.trim() &&
      ((followup.targetConfidence ?? 0) >= 0.6 || aiDecisionAuthoritative)
        ? `\nFOLLOW-UP ANSWER CONTEXT (for this request only):\nSelected prior answer excerpt:\n${selectedTargetForRequest.answer
            .trim()
            .slice(0, 800)}`
        : "";
    const noCodeFollowupGuidance =
      (followup.isExplicitFollowupReference ||
        (aiDecisionAuthoritative && aiDecision.requiresPreviousCode) ||
        isRegenerate) &&
      (isCodeFollowupQuestion(guard.resolvedCurrentQuestion) || aiDecision.requiresPreviousCode) &&
      selectedCodeContext.codeBlocks.length === 0 &&
      !hasAnyRecentCodeHistory
        ? "\nFOLLOW-UP CONTEXT: I do not have a previous code/query in this session to explain. State this briefly, then provide generic guidance."
        : "";
    const strictFollowupBindingApplied = Boolean(
      selectedTargetForRequest &&
      (codeFollowupConstraint || selectedAnswerExcerptBlock),
    );
    const regenerateInstructionBlock =
      isRegenerate && (liveContextMetadata as any)?.regenerateInstruction
        ? `\nREGENERATE INSTRUCTION:\n${String((liveContextMetadata as any).regenerateInstruction).slice(0, 500)}`
        : "";
    const regenerateUsedOriginalQuestion = Boolean(
      isRegenerate && guard.resolvedCurrentQuestion?.trim(),
    );
    const regenerateUsedOriginalTranscript = Boolean(
      isRegenerate && transcript?.trim(),
    );
    const regeneratePreservedSelectedTarget = Boolean(
      isRegenerate &&
      (liveContextMetadata?.selectedAnswerId || selectedTargetForRequest),
    );
    const regenerateInstructionApplied = Boolean(
      isRegenerate &&
      (liveContextMetadata as any)?.regenerateInstruction,
    );
    const shouldForceDiagram = isProjectExplainQuestion(guard.resolvedCurrentQuestion);
    const selectedArchitectureDiagram = shouldForceDiagram
      ? extractArchitectureDiagramBlock(contextForCall?.projects)
      : null;
    const synthesizedArchitectureDiagram = shouldForceDiagram && !selectedArchitectureDiagram
      ? synthesizeArchitectureFlowFromProjectContext(contextForCall?.projects)
      : null;
    const architectureFlowForPrompt =
      selectedArchitectureDiagram || synthesizedArchitectureDiagram;
    const projectDiagramConstraint =
      shouldForceDiagram && architectureFlowForPrompt
        ? `\nPROJECT-EXPLAIN DIAGRAM REQUIREMENT (HARD):\n- The user asked to explain project(s).\n- You MUST include one markdown architecture flow block under **ANSWER:** using fenced \`\`\`text.\n- Use the architecture flow context below as your structure; stay conservative and do not invent unrelated systems.\nArchitecture flow source:\n\`\`\`text\n${architectureFlowForPrompt}\n\`\`\``
        : "";
    const authoritativeQuestionConstraint = `\nCURRENT QUESTION (AUTHORITATIVE):\n${guard.resolvedCurrentQuestion}\n\nOUTPUT QUESTION RULE (HARD):\n- In the first **QUESTION:** block, repeat ONLY the CURRENT QUESTION above as one clean line.\n- Do NOT prepend previous questions, transcript lines, or earlier turn text.\n- Do NOT merge prior turns unless the CURRENT QUESTION itself explicitly contains multiple independent questions.`;
    const orchestratorPacketBlock = orchestration
      ? `\n${orchestration.contextPacket}\n`
      : "";
    const userMessage = `${policy.policyBlock}${orchestratorPacketBlock}${codeFollowupConstraint}\n${policy.codeContextBlock}${selectedAnswerExcerptBlock}${noCodeFollowupGuidance}${regenerateInstructionBlock}${projectDiagramConstraint}${authoritativeQuestionConstraint}\n\n${baseUserMessage}`;
    const systemTokens = estimatePromptTokensForLog(systemPrompt);
    const userTokens = estimatePromptTokensForLog(userMessage);
    console.log(`[CIE] Prompt breakdown | system: ${systemTokens}t | user: ${userTokens}t | total: ${systemTokens + userTokens}t | complexity: ${contextForCall?.complexity || 'unknown'}`);
    if (process.env.NODE_ENV !== "production") {
      console.log("[AI Answer Policy][BE]", {
        resolvedCurrentQuestion: guard.resolvedCurrentQuestion,
        originalResolvedQuestion: guard.originalResolvedQuestion,
        reconstructedResolvedQuestion: guard.reconstructedResolvedQuestion,
        weakQuestionReconstructedBackend: guard.weakQuestionReconstructedBackend,
        questionPollutionDetected: guard.questionPollutionDetected,
        conversationIntent,
        aiDecisionIntent: aiDecision.intent,
        aiDecisionConfidence: aiDecision.confidence,
        aiDecisionTargetAnswerId: aiDecision.targetAnswerId,
        aiDecisionReason: aiDecision.reason,
        aiDecisionContextToUse: aiDecision.contextToUse,
        fallbackDecisionUsed: aiDecisionResult.fallbackDecisionUsed,
        aiDecisionError: aiDecisionResult.error || null,
        contextBindingSource: aiDecisionAuthoritative && aiDecisionTarget
          ? "ai_decision"
          : aiDecisionLatestCodeTarget
            ? "ai_decision_latest_code"
          : selectedTargetForRequest
            ? followup.source
            : "none",
        backendDetectedFollowup,
        frontendDetectedFollowup: !!detection?.isFollowUp,
        isExplicitFollowupReference: followup.isExplicitFollowupReference,
        selectedAnswerIdFromFrontend: liveContextMetadata?.selectedAnswerId || null,
        selectedAnswerTopic: selectedAnswerTopicForLog || null,
        selectedAnswerIgnoredReason: followup.selectedAnswerIgnoredReason || null,
        previousAiAnswerIgnoredReason,
        answerMemoryCount: history.length,
        selectedFollowupTargetId: selectedTargetForRequest?.id || null,
        followupTargetId: selectedTargetForRequest?.id || null,
        selectedFollowupTopic: selectedTargetForRequest?.topic || null,
        followupTargetTopic: selectedTargetForRequest?.topic || null,
        reasonForNoTarget: followup.reasonForNoTarget || null,
        selectedCodeBlockLanguage: selectedCodeContext.language,
        selectedCodeBlockPreview: selectedCodeContext.preview,
        followupTargetSource: followup.source,
        followupTargetHasCode: !!selectedTargetForRequest?.codeBlocks?.length,
        strictFollowupBindingApplied,
        isRegenerate,
        regenerateTargetAnswerId:
          (liveContextMetadata as any)?.regenerateTargetAnswerId || null,
        regenerateUsedOriginalQuestion,
        regenerateUsedOriginalTranscript,
        regeneratePreservedSelectedTarget,
        regenerateInstructionApplied,
        diagramConstraintApplied: Boolean(projectDiagramConstraint),
        questionTopic: deriveTopic(guard.resolvedCurrentQuestion, effectiveMetadata.previousAiAnswer),
        answerIntent: policy.answerIntent,
        effectiveAnswerMode: policy.effectiveAnswerMode,
        isCodeFollowup: policy.isCodeFollowup,
        codeBlocksInjectedCount: policy.codeBlocksInjectedCount,
        previousAiAnswerExcerptLength: policy.previousAiAnswerExcerptLength,
        experienceSuppressed: policy.experienceSuppressed,
        cieTierSelected: contextForCall?.complexity || "unknown",
      });
    }

    const result = ai.callModel({
      model: targetModel,
      maxOutputTokens: resolveAnswerMaxOutputTokens({
        complexity: contextForCall?.complexity,
        question: guard.resolvedCurrentQuestion,
        isRegenerate,
        hasProjects: !!contextForCall?.hasSelectedProjects,
      }),
      provider: latencyOptimizedProvider as any,
      store: false,
      sessionId: id,
      input: [
        {
          role: "system",
          type: "message",
          content: systemPrompt,
        } as any,
        {
          role: "user",
          type: "message",
          content: userMessage,
        },
      ],
    });

    return processAIStream(
      result,
      session,
      id,
      isCustomQuery ? finalTranscript : finalTranscript.slice(0, 300),
      contextForCall,
      targetModel,
      finalSnapshotId,
      isRegenerate,
      guard.resolvedCurrentQuestion,
      orchestration?.questionMeta,
      orchestration,
    );
  } catch (err: any) {
    console.error("OpenRouter Streaming Error (getAIAnswer):", err);
    if (err.status === 429 || err.statusCode === 429) {
      return (async function* () {
        yield {
          text: "AI is temporarily rate-limited. Please wait a moment and try again.",
        };
      })();
    }
    throw err;
  }
}

/**
 * Transcribes audio (Placeholder - implementation logic needed or restored).
 */
export async function transcribe(file: Express.Multer.File) {
  // Logic to call transcription service (e.g., Deepgram/Sarvam)
  return { text: "Transcription placeholder (restored)" };
}

/**
 * Appends a message to the session's JSON messages array AND (when allowed) the Transcript array.
 * When `saveTranscription === false` the entire DB write is skipped — no messages, no transcript.
 * This prevents any data from accumulating for ephemeral sessions.
 */
export async function appendMessage(
  sessionId: string,
  role: LiveMessageRole,
  question: string,
  answer: string,
  time?: string,
  snapshotId?: string,
  messageId?: string,
): Promise<AppendMessageResult | undefined> {
  const startedAt = Date.now();
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, saveTranscription: true },
  });

  if (!session) throw new Error("Session not found");

  // Ephemeral session — user opted out of all persistence.
  // Skip both messages[] and transcript[] writes entirely.
  if (session.saveTranscription === false) return { messageId, saved: false };

  const timestamp = Date.now();
  const resolvedMessageId = messageId || crypto.randomUUID();
  const chunk = await prisma.transcriptChunk.create({
    data: {
      sessionId,
      userId: session.userId,
      questionId: resolvedMessageId,
      question,
      aiAnswer: answer || null,
      content: buildTranscriptContent(question, answer || ""),
      technologies: [],
      speakerType: mapLiveRoleToSpeakerType(role),
      chunkType: mapLiveRoleToChunkType(role),
      questionGroupId: LIVE_TRANSCRIPT_GROUP_ID,
      startTime: timestamp,
      isQuestion: role === "INTERVIEWER",
    },
  });

  scheduleLegacyTranscriptFlush(sessionId, LEGACY_TRANSCRIPT_FLUSH_DELAY_MS);
  const totalMs = Date.now() - startedAt;
  const logPayload = { sessionId, messageId: resolvedMessageId, role, totalMs };
  if (totalMs > 500) console.warn("[save-message][slow]", logPayload);
  else console.info("[save-message][fast]", logPayload);

  return { messageId: resolvedMessageId, transcriptChunkId: chunk.id, saved: true };
}

function normalizePatchText(text: string): string {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export async function patchTranscriptMessage(
  sessionId: string,
  messageId: string,
  payload: {
    patchedText: string;
    originalText?: string;
    patchedAt?: string;
    patchedByUser?: boolean;
    sender?: "User" | "Interviewer";
    timestamp?: number;
  },
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, saveTranscription: true },
  });

  if (!session) throw new Error("Session not found");
  if (session.saveTranscription === false) return;

  const patchedText = payload.patchedText?.trim();
  if (!patchedText) throw new Error("patchedText is required");

  const patchedAt = payload.patchedAt || new Date().toISOString();
  const patchedByUser = payload.patchedByUser !== false;
  const originalTextNormalized = normalizePatchText(payload.originalText || "");
  const senderRole =
    payload.sender === "User"
      ? "USER"
      : payload.sender === "Interviewer"
        ? "INTERVIEWER"
        : undefined;

  const chunkPatch = await prisma.transcriptChunk.updateMany({
    where: {
      sessionId,
      questionGroupId: LIVE_TRANSCRIPT_GROUP_ID,
      questionId: messageId,
    },
    data: {
      question: patchedText,
      content: patchedText,
    },
  });

  if (chunkPatch.count > 0) {
    scheduleLegacyTranscriptFlush(sessionId, 250);
    return { id: sessionId, patchedChunks: chunkPatch.count };
  }

  const legacySession = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { messages: true, transcript: true },
  });
  if (!legacySession) throw new Error("Session not found");

  const messages = Array.isArray(legacySession.messages) ? ([...legacySession.messages] as any[]) : [];
  const transcript = Array.isArray(legacySession.transcript) ? ([...legacySession.transcript] as any[]) : [];

  const findLegacyMessageIndex = () => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (senderRole && m.role !== senderRole) continue;
      const qNorm = normalizePatchText(m.question || "");
      if (originalTextNormalized && qNorm === originalTextNormalized) return i;
      if (
        payload.timestamp &&
        m.timestamp &&
        Math.abs(new Date(m.timestamp).getTime() - payload.timestamp) < 15000
      ) {
        return i;
      }
    }
    return -1;
  };

  const findLegacyTranscriptIndex = () => {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const t = transcript[i];
      if (senderRole && t.role !== senderRole) continue;
      const cNorm = normalizePatchText(t.content || t.question || "");
      if (originalTextNormalized && cNorm === originalTextNormalized) return i;
      if (
        payload.timestamp &&
        t.createdAt &&
        Math.abs(new Date(t.createdAt).getTime() - payload.timestamp) < 15000
      ) {
        return i;
      }
    }
    return -1;
  };

  let messageUpdated = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].messageId && messages[i].messageId === messageId) {
      const prev = messages[i];
      messages[i] = {
        ...prev,
        messageId,
        originalText: prev.originalText || prev.question,
        patchedText,
        patchedAt,
        patchedByUser,
        question: patchedText,
      };
      messageUpdated = true;
      break;
    }
  }
  if (!messageUpdated) {
    const idx = findLegacyMessageIndex();
    if (idx >= 0) {
      const prev = messages[idx];
      messages[idx] = {
        ...prev,
        messageId,
        originalText: prev.originalText || prev.question,
        patchedText,
        patchedAt,
        patchedByUser,
        question: patchedText,
      };
    }
  }

  let transcriptUpdated = false;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].messageId && transcript[i].messageId === messageId) {
      const prev = transcript[i];
      transcript[i] = {
        ...prev,
        messageId,
        originalText: prev.originalText || prev.content || prev.question,
        patchedText,
        patchedAt,
        patchedByUser,
        question: patchedText,
        content: patchedText,
      };
      transcriptUpdated = true;
      break;
    }
  }
  if (!transcriptUpdated) {
    const idx = findLegacyTranscriptIndex();
    if (idx >= 0) {
      const prev = transcript[idx];
      transcript[idx] = {
        ...prev,
        messageId,
        originalText: prev.originalText || prev.content || prev.question,
        patchedText,
        patchedAt,
        patchedByUser,
        question: patchedText,
        content: patchedText,
      };
    }
  }

  return prisma.session.update({
    where: { id: sessionId },
    data: {
      messages,
      transcript,
    },
    select: { id: true, messages: true, transcript: true },
  });
}

export async function updateMessageAnswer(
  sessionId: string,
  snapshotId: string,
  question: string,
  answer: string
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { messages: true, transcript: true, saveTranscription: true },
  });

  if (!session) throw new Error("Session not found");
  if (session.saveTranscription === false) return;

  let messages = Array.isArray(session.messages) ? (session.messages as any[]) : [];
  let transcript = Array.isArray(session.transcript) ? (session.transcript as any[]) : [];

  let found = false;

  messages = messages.map((m) => {
    if (m.snapshotId === snapshotId) {
      found = true;
      return {
        ...m,
        question,
        answer,
        timestamp: new Date().toISOString(),
      };
    }
    return m;
  });

  transcript = transcript.map((t) => {
    if (t.snapshotId === snapshotId) {
      return {
        ...t,
        question,
        answer,
        content: `Q: ${question}\n\nA: ${answer}`,
      };
    }
    return t;
  });

  if (!found) {
    const newMessage = {
      role: "AI_ASSISTANT",
      question,
      answer,
      timestamp: new Date().toISOString(),
      snapshotId,
    };
    const transcriptEntry = {
      role: "AI_ASSISTANT",
      question,
      answer,
      content: `Q: ${question}\n\nA: ${answer}`,
      createdAt: new Date().toISOString(),
      snapshotId,
    };
    messages.push(newMessage);
    transcript.push(transcriptEntry);
  }

  return prisma.session.update({
    where: { id: sessionId },
    data: {
      messages,
      transcript,
    },
  });
}

export async function saveTranscript(
  sessionId: string,
  role: string,
  content: string,
  time?: string,
  question?: string,
  answer?: string,
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { transcript: true, saveTranscription: true },
  });

  if (!session) throw new Error("Session not found");

  // Honour the user's transcript preference — skip writing if opted out.
  if (session.saveTranscription === false) return;

  const currentTranscript = Array.isArray(session.transcript)
    ? (session.transcript as any[])
    : [];

  const transcriptEntry = {
    role,
    content,
    question,
    answer,
    time:
      time ||
      new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    createdAt: new Date().toISOString(),
  };

  return prisma.session.update({
    where: { id: sessionId },
    data: {
      transcript: [...currentTranscript, transcriptEntry],
    },
  });
}

/**
 * Generates and saves post-session analytics feedback using AI.
 * This analyzes the transcript, QA records, and session context (Resume/JD).
 * @param rawTranscript Optional transcript string provided directly
 */
export async function generateSessionFeedback(
  sessionId: string,
  rawTranscript?: string,
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      questions: { orderBy: { createdAt: "asc" } },
      company: true,
    },
  });

  if (!session) throw new Error("Session not found");

  // Fetch Resume context if available
  let resumeContext = "";
  if (session.resumeId) {
    try {
      const resume = await getUnifiedResumeContext(session.resumeId);
      resumeContext = resume?.resumeContext || "";
    } catch (e) {
      console.warn("Failed to fetch resume context for analytics:", e);
    }
  }

  // Fetch Document context if available
  let documentContext = "";
  if (session.documentId) {
    try {
      const doc = await prisma.document.findUnique({
        where: { id: session.documentId },
      });
      if (doc) {
        const ext = path.extname(doc.path).toLowerCase();
        documentContext = await documentService.extractTextFromFile(
          doc.path,
          ext,
        );
      }
    } catch (e) {
      console.warn("Failed to fetch document context for analytics:", e);
    }
  }

  // Use provided rawTranscript or build it from the transcript JSON field
  let formattedTranscript = "";
  if (rawTranscript) {
    formattedTranscript = rawTranscript;
  } else {
    const transcriptArray = Array.isArray(session.transcript)
      ? (session.transcript as any[])
      : [];

    formattedTranscript = transcriptArray
      .map((t) => `[${t.time || t.createdAt}] ${t.role}: ${t.content}`)
      .join("\n");

    // Fallback: If transcripts table is empty, check extraContext
    if (!formattedTranscript && session.extraContext) {
      formattedTranscript = session.extraContext;
    }
  }

  const formattedQA = session.questions
    .map(
      (q, i) =>
        `Q${i + 1}: ${q.ques}\nA${i + 1}: ${q.answer || "No answer provided"}`,
    )
    .join("\n\n");

  const messagesArray = Array.isArray(session.messages)
    ? (session.messages as any[])
    : [];
  const formattedMessages = messagesArray
    .map(
      (m, i) =>
        `Message ${i + 1} (${m.role}) [${m.time || m.timestamp}]:\nQuestion: ${m.question}\nAI Suggested Answer: ${m.answer}`,
    )
    .join("\n\n");

  const userPrompt = buildAnalyticsUserPrompt({
    company: session.companyName || session.company?.name || "Unknown",
    role: session.jobDescription || "Not specified",
    language: session.language || "General",
    aiUsage: session.aiUsage || 0,
    resumeContext,
    documentContext: documentContext.substring(0, 5000),
    mode: session.mode,
    extraContext: session.extraContext || "None",
    transcript: formattedTranscript,
    qa: formattedQA,
    messages: formattedMessages,
  });

  try {
    const result = ai.callModel({
      model,
      input: [
        { role: "system", type: "message", content: ANALYTICS_SYSTEM_PROMPT },
        { role: "user", type: "message", content: userPrompt },
      ],
      text: {
        format: { type: "json_object" },
      },
    });

    const content = await result.getText();

    if (!content) throw new Error("No content received from AI");

    // Robust JSON extraction (handles markdown blocks if model still provides them)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const feedbackData = JSON.parse(jsonMatch ? jsonMatch[0] : content);

    // Upsert feedback
    return await prisma.sessionFeedback.upsert({
      where: { sessionId },
      create: {
        sessionId,
        score: feedbackData.score || 0,
        confidence: feedbackData.confidence || 0,
        sessionQuality: feedbackData.sessionQuality || "N/A",
        verdict: feedbackData.verdict || "N/A",
        communication: feedbackData.communication || 0,
        interactivity: feedbackData.interactivity || 0,
        technicalDepth: feedbackData.technicalDepth || 0,
        conciseness: feedbackData.conciseness || 0,
        avgResponseLen: feedbackData.avgResponseLen || 0,
        answeredCount: feedbackData.answeredCount || 0,
        aiAssistsCount: session.aiUsage || 0,
        avgResponseTime: feedbackData.avgResponseTime || 0,
        strengths: feedbackData.strengths || [],
        improvements: feedbackData.improvements || [],
        interviewerMood: feedbackData.interviewerMood || "N/A",
      },
      update: {
        score: feedbackData.score || 0,
        confidence: feedbackData.confidence || 0,
        sessionQuality: feedbackData.sessionQuality || "N/A",
        verdict: feedbackData.verdict || "N/A",
        communication: feedbackData.communication || 0,
        interactivity: feedbackData.interactivity || 0,
        technicalDepth: feedbackData.technicalDepth || 0,
        conciseness: feedbackData.conciseness || 0,
        avgResponseLen: feedbackData.avgResponseLen || 0,
        answeredCount: feedbackData.answeredCount || 0,
        aiAssistsCount: session.aiUsage || 0,
        avgResponseTime: feedbackData.avgResponseTime || 0,
        strengths: feedbackData.strengths || [],
        improvements: feedbackData.improvements || [],
        interviewerMood: feedbackData.interviewerMood || "N/A",
      },
    });
  } catch (error) {
    console.error("Error generating session feedback:", error);
    throw new Error("Failed to generate session feedback");
  }
}
