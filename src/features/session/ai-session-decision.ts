import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";
import type {
  AnswerHistoryEntry,
  ConversationIntent,
  FollowupTargetResult,
} from "./answer-quality";

export type AISessionDecisionIntent =
  | "NEW_QUESTION"
  | "FOLLOW_UP"
  | "CONTINUE_PREVIOUS"
  | "EXPLAIN_CODE"
  | "DEBUG_CODE"
  | "OPTIMIZE_CODE"
  | "SCENARIO_QUESTION"
  | "EXPERIENCE_QUESTION"
  | "INTERVIEW_INSTRUCTION"
  | "UNKNOWN";

export type AISessionDecisionAnswerMode =
  | "auto"
  | "theory_only"
  | "minimal_code"
  | "code_required"
  | "explain_existing_code"
  | "system_design";

export interface AISessionDecision {
  intent: AISessionDecisionIntent;
  isFollowUp: boolean;
  targetAnswerId: string | null;
  requiresPreviousCode: boolean;
  answerMode: AISessionDecisionAnswerMode;
  topic: string;
  confidence: number;
  reason: string;
  contextToUse: "none" | "previous_answer" | "previous_code" | "selected_answer" | "recent_transcript";
}

export interface AISessionDecisionContextTarget {
  id: string;
  question: string;
  answerExcerpt: string;
  topic: string;
  hasCode: boolean;
  codePreview: string | null;
  orderIndex: number;
  recency: "older" | "most_recent";
}

export interface AISessionDecisionInput {
  currentQuestion: string;
  recentTranscriptWindow?: string[];
  speakerSeparatedTranscript?: AIAnswerLiveContextMetadata["speakerSeparatedTranscript"];
  activeQuestionDetection?: AIAnswerLiveContextMetadata["activeQuestionDetection"];
  previousAiAnswer?: string;
  previousAiAnswers?: AIAnswerLiveContextMetadata["previousAiAnswers"];
  previousCodeBlocks?: string[];
  selectedAnswerId?: string;
  selectedAnswerQuestion?: string;
  selectedAnswerText?: string;
  selectedAnswerTopic?: string;
  answerHistory: AISessionDecisionContextTarget[];
  deterministic: {
    conversationIntent: ConversationIntent;
    isExplicitFollowupReference: boolean;
    fallbackTargetId: string | null;
    fallbackTargetHasCode: boolean;
    fallbackTargetTopic: string | null;
    reasonForNoTarget?: string;
  };
}

export interface AISessionDecisionResult {
  decision: AISessionDecision;
  fallbackDecisionUsed: boolean;
  rawResponse?: string;
  error?: string;
}

const VALID_INTENTS = new Set<AISessionDecisionIntent>([
  "NEW_QUESTION",
  "FOLLOW_UP",
  "CONTINUE_PREVIOUS",
  "EXPLAIN_CODE",
  "DEBUG_CODE",
  "OPTIMIZE_CODE",
  "SCENARIO_QUESTION",
  "EXPERIENCE_QUESTION",
  "INTERVIEW_INSTRUCTION",
  "UNKNOWN",
]);

const VALID_ANSWER_MODES = new Set<AISessionDecisionAnswerMode>([
  "auto",
  "theory_only",
  "minimal_code",
  "code_required",
  "explain_existing_code",
  "system_design",
]);

const VALID_CONTEXT = new Set<AISessionDecision["contextToUse"]>([
  "none",
  "previous_answer",
  "previous_code",
  "selected_answer",
  "recent_transcript",
]);

const FOLLOWUP_INTENTS = new Set<AISessionDecisionIntent>([
  "FOLLOW_UP",
  "CONTINUE_PREVIOUS",
  "EXPLAIN_CODE",
  "DEBUG_CODE",
  "OPTIMIZE_CODE",
  "SCENARIO_QUESTION",
]);

const CODE_INTENTS = new Set<AISessionDecisionIntent>([
  "EXPLAIN_CODE",
  "DEBUG_CODE",
  "OPTIMIZE_CODE",
]);

function clip(text: string | undefined, max: number): string {
  return (text || "").trim().slice(0, max);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function extractJsonObject(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

function shouldKeepContinueOnActiveBranch(question: string): boolean {
  const q = (question || "").toLowerCase();
  if (!/\bcontinue\b/.test(q)) return false;
  return !/\b(same query|that query|previous query|same code|that code|previous code|optimi[sz]e|debug|fix)\b/.test(q);
}

export function toDecisionContextTargets(
  history: AnswerHistoryEntry[],
): AISessionDecisionContextTarget[] {
  const recent = history.slice(-6);
  return recent
    .map((entry) => ({
      id: entry.id,
      question: clip(entry.question, 220),
      answerExcerpt: clip(entry.answer.replace(/```[\s\S]*?```/g, "[code block]"), 420),
      topic: entry.topic || "general",
      hasCode: entry.codeBlocks.length > 0,
      codePreview: entry.codeBlocks[0] ? clip(entry.codeBlocks[0], 220) : null,
      orderIndex: entry.orderIndex,
      recency: entry === recent[recent.length - 1] ? "most_recent" : "older",
    }));
}

export function fallbackAISessionDecision(input: {
  currentQuestion: string;
  conversationIntent: ConversationIntent;
  followup: FollowupTargetResult;
}): AISessionDecision {
  const intent = input.conversationIntent as AISessionDecisionIntent;
  const target = input.followup.target;
  const isCodeIntent = CODE_INTENTS.has(intent);
  return {
    intent: VALID_INTENTS.has(intent) ? intent : "UNKNOWN",
    isFollowUp: input.followup.isExplicitFollowupReference || FOLLOWUP_INTENTS.has(intent),
    targetAnswerId: target?.id || null,
    requiresPreviousCode: isCodeIntent,
    answerMode: isCodeIntent ? "explain_existing_code" : intent === "SCENARIO_QUESTION" ? "system_design" : "auto",
    topic: target?.topic || "general",
    confidence: target ? 0.68 : input.followup.isExplicitFollowupReference ? 0.52 : 0.35,
    reason: input.followup.reasonForNoTarget || "deterministic_fallback",
    contextToUse: target?.codeBlocks?.length && isCodeIntent
      ? "previous_code"
      : target
        ? "previous_answer"
        : "none",
  };
}

export function normalizeAISessionDecision(
  raw: unknown,
  input: AISessionDecisionInput,
): AISessionDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const rawRecord = raw as Record<string, unknown>;
  const data =
    !("intent" in rawRecord) &&
    rawRecord.schema &&
    typeof rawRecord.schema === "object"
      ? rawRecord.schema as Record<string, unknown>
      : !("intent" in rawRecord) &&
        rawRecord.outputContract &&
        typeof rawRecord.outputContract === "object"
        ? rawRecord.outputContract as Record<string, unknown>
      : rawRecord;
  const intent = asString(data.intent, "UNKNOWN") as AISessionDecisionIntent;
  if (!VALID_INTENTS.has(intent)) return null;

  const confidenceRaw = Number(data.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;

  const targetAnswerId = typeof data.targetAnswerId === "string" && data.targetAnswerId.trim()
    ? data.targetAnswerId.trim()
    : null;
  const targetExists = !targetAnswerId || input.answerHistory.some((h) => h.id === targetAnswerId);
  if (!targetExists) return null;

  const answerModeRaw = asString(data.answerMode, "auto") as AISessionDecisionAnswerMode;
  const answerMode = VALID_ANSWER_MODES.has(answerModeRaw) ? answerModeRaw : "auto";
  const contextRaw = asString(data.contextToUse, "none") as AISessionDecision["contextToUse"];
  const contextToUse = VALID_CONTEXT.has(contextRaw) ? contextRaw : "none";
  const inferredFollowup = FOLLOWUP_INTENTS.has(intent);
  const requiresPreviousCode = Boolean(data.requiresPreviousCode) || CODE_INTENTS.has(intent);

  const decision: AISessionDecision = {
    intent,
    isFollowUp: typeof data.isFollowUp === "boolean" ? data.isFollowUp : inferredFollowup,
    targetAnswerId,
    requiresPreviousCode,
    answerMode,
    topic: clip(asString(data.topic, "general"), 80) || "general",
    confidence,
    reason: clip(asString(data.reason, "ai_decision"), 240) || "ai_decision",
    contextToUse,
  };

  const mostRecent = input.answerHistory[input.answerHistory.length - 1];
  if (
    mostRecent &&
    intent === "CONTINUE_PREVIOUS" &&
    shouldKeepContinueOnActiveBranch(input.currentQuestion)
  ) {
    return {
      ...decision,
      targetAnswerId: mostRecent.id,
      requiresPreviousCode: false,
      answerMode: decision.answerMode === "system_design" ? "system_design" : "auto",
      topic: mostRecent.topic || decision.topic,
      reason: `${decision.reason} | active_branch_guard: continue stayed on most recent answer`,
      contextToUse: "previous_answer",
    };
  }

  return decision;
}

export function buildAISessionDecisionMessages(input: AISessionDecisionInput) {
  const system = [
    "You are ScribeShade's backend session-state decision layer.",
    "Return strict JSON only. No markdown, no prose.",
    "Decide whether the current input is a new interview question or a continuation of prior session context.",
    "Prefer semantic context over keyword matching. Use previous question/answer/code and transcript chronology.",
    "answerHistory is ordered oldest to newest. The entry marked recency='most_recent' is the latest AI answer.",
    "If the user asks about the same query/code being slow, taking seconds, fetching records slowly, debugging, optimizing, or changing behavior, classify it as OPTIMIZE_CODE or DEBUG_CODE and bind previous code when available.",
    "For any current input that begins with or mainly says 'continue', target mostRecentAnswer.id by default.",
    "If the user says 'continue from X part', default to the most recent prior AI answer. Only jump to an older answer if the user explicitly names that older answer, says same query/code, or references a selected answer/card.",
    "For ambiguous 'continue from database part', prefer the most_recent answer over older SQL/code because the user is usually continuing the current conversation branch.",
    "Only target older SQL/code when the current input explicitly says same query, that query, previous query, code, optimize, debug, or similar code-specific wording.",
    "If the user asks 'why your changes help' after an optimization answer, classify as FOLLOW_UP or EXPLAIN_CODE and target the most recent optimization answer.",
    "If the user asks where they used something in actual projects, classify as EXPERIENCE_QUESTION and use recent_transcript/project context.",
    "Do not attach stale context to a clearly unrelated fresh question.",
  ].join("\n");

  const user = JSON.stringify({
    outputContract: {
      instruction: "Return exactly this JSON object shape at top level. Do not wrap it inside schema or any other key.",
      intent: "NEW_QUESTION | FOLLOW_UP | CONTINUE_PREVIOUS | EXPLAIN_CODE | DEBUG_CODE | OPTIMIZE_CODE | SCENARIO_QUESTION | EXPERIENCE_QUESTION | INTERVIEW_INSTRUCTION | UNKNOWN",
      isFollowUp: "boolean",
      targetAnswerId: "string id from answerHistory or null",
      requiresPreviousCode: "boolean",
      answerMode: "auto | theory_only | minimal_code | code_required | explain_existing_code | system_design",
      topic: "short topic",
      confidence: "0..1",
      reason: "short reason",
      contextToUse: "none | previous_answer | previous_code | selected_answer | recent_transcript",
    },
    currentQuestion: input.currentQuestion,
    recentTranscriptWindow: input.recentTranscriptWindow?.slice(-20) || [],
    speakerSeparatedTranscript: (input.speakerSeparatedTranscript || []).slice(-20),
    activeQuestionDetection: input.activeQuestionDetection || null,
    previousAiAnswer: clip(input.previousAiAnswer, 700),
    previousAiAnswers: (input.previousAiAnswers || [])
      .slice(-2)
      .map((entry) => ({
        ...(entry.question ? { question: clip(entry.question, 220) } : {}),
        answer: clip(entry.answer, 700),
        codeBlocks: (entry.codeBlocks || []).slice(0, 2).map((block) => clip(block, 320)),
      })),
    previousCodeBlocks: (input.previousCodeBlocks || []).slice(0, 2).map((b) => clip(b, 700)),
    selectedAnswer: input.selectedAnswerId
      ? {
          id: input.selectedAnswerId,
          question: clip(input.selectedAnswerQuestion, 260),
          answerExcerpt: clip(input.selectedAnswerText, 700),
          topic: input.selectedAnswerTopic || null,
        }
      : null,
    answerHistory: input.answerHistory,
    mostRecentAnswer: input.answerHistory[input.answerHistory.length - 1] || null,
    activeConversationBranch: input.answerHistory[input.answerHistory.length - 1]
      ? {
          latestAnswerId: input.answerHistory[input.answerHistory.length - 1].id,
          latestQuestion: input.answerHistory[input.answerHistory.length - 1].question,
          latestTopic: input.answerHistory[input.answerHistory.length - 1].topic,
          latestAnswerExcerpt: input.answerHistory[input.answerHistory.length - 1].answerExcerpt,
        }
      : null,
    deterministicSignal: input.deterministic,
  });

  return { system, user };
}

export async function decideAISessionState(params: {
  ai: any;
  model: string | undefined;
  provider?: any;
  input: AISessionDecisionInput;
  fallback: AISessionDecision;
  timeoutMs?: number;
}): Promise<AISessionDecisionResult> {
  const timeoutMs = params.timeoutMs ?? Number(process.env.AI_SESSION_DECISION_TIMEOUT_MS || 1600);
  const { system, user } = buildAISessionDecisionMessages(params.input);
  const decisionModel = process.env.AI_SESSION_DECISION_MODEL || "openai/gpt-4o-mini";

  if (!decisionModel) {
    return {
      decision: params.fallback,
      fallbackDecisionUsed: true,
      error: "missing_decision_model",
    };
  }

  try {
    const result = params.ai.callModel({
      model: decisionModel,
      maxOutputTokens: 350,
      provider: params.provider,
      store: false,
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
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("ai_session_decision_timeout")), timeoutMs),
      ),
    ]);
    const normalized = normalizeAISessionDecision(extractJsonObject(content), params.input);
    if (!normalized) {
      return {
        decision: params.fallback,
        fallbackDecisionUsed: true,
        rawResponse: content,
        error: "invalid_ai_session_decision",
      };
    }
    return {
      decision: normalized,
      fallbackDecisionUsed: false,
      rawResponse: content,
    };
  } catch (err) {
    return {
      decision: params.fallback,
      fallbackDecisionUsed: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
