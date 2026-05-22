import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";

type FollowupTargetSource =
  | "selected_answer"
  | "topic_match"
  | "latest_code"
  | "immediate_previous"
  | "none";

export interface AnswerHistoryEntry {
  id: string;
  question: string;
  answer: string;
  timestamp: number;
  codeBlocks: string[];
  topic: string;
  orderIndex: number;
}

export interface GuardResult {
  resolvedCurrentQuestion: string;
  questionPollutionDetected: boolean;
}

export interface FollowupTargetResult {
  target: AnswerHistoryEntry | null;
  source: FollowupTargetSource;
  isExplicitFollowupReference: boolean;
  reasonForNoTarget?: string;
  selectedAnswerIgnoredReason?: string;
  targetConfidence?: number;
}

const FILLER_ONLY_RE = /^(hi|hello|hey|can you hear me|am i audible|okay|ok|hmm|huh|right|fine)$/i;
const EXPLICIT_EXPERIENCE_RE =
  /\b(your experience|your project|your company|tell me about your project|from your project|in your company|in your project|where have you used|how have you used)\b/i;
const CODE_REF_RE =
  /\b(this code|your code|the code you wrote|above code|previous code|first line|that query|the query|query you wrote|query you wrote before|that code|what does this code do|explain it|optimi[sz]e it|debug it|previous answer|above answer)\b/i;
const FOLLOWUP_RE =
  /\b(explain this|explain that|expand on that|can you expand|can you explain more|why did you use this|what does this mean|previous answer|above answer|before|you wrote|you said|repeat the answer|what did you say)\b/i;
const VAGUE_DEICTIC_RE =
  /^(?:explain it|continue|why\??|how so\??|elaborate|expand)\s*$/i;
const HIGH_CONFIDENCE_THRESHOLD = 1.5;

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function normLoose(text: string): string {
  return normalizeSpaces(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  return normLoose(text).split(" ").filter(Boolean);
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap += 1;
  return overlap / Math.max(ta.size, tb.size);
}

function isLikelyPollutedJoin(question: string): boolean {
  const q = normalizeSpaces(question);
  if (!q) return false;
  const lower = q.toLowerCase();
  if (/\bplus\b/.test(lower) && /\bwhat is\b[\s\S]*\bwhat is\b/.test(lower)) return true;
  const starterCount = (lower.match(/\b(what is|what are|explain|define|how|why|when|where|which|who|implement|write|debug|optimi[sz]e)\b/g) || []).length;
  const hasJoiner = /\b(plus|and then|also|along with)\b/i.test(lower);
  const hasQuestionMark = q.includes("?");
  return starterCount >= 2 && hasJoiner && hasQuestionMark;
}

function keepLatestMeaningfulQuestion(question: string): string {
  if (/\bplus\b/i.test(question) || /\band then\b/i.test(question)) {
    const clauses = question
      .split(/\b(?:plus|and then|also|along with)\b/i)
      .map((c) => normalizeSpaces(c))
      .filter(Boolean);
    for (let i = clauses.length - 1; i >= 0; i -= 1) {
      const clause = clauses[i];
      if (!FILLER_ONLY_RE.test(clause) && clause.length >= 6) {
        return clause.endsWith("?") ? clause : `${clause}?`;
      }
    }
  }

  const parts = question
    .split(/\?+/)
    .map((p) => normalizeSpaces(p))
    .filter(Boolean);
  if (parts.length <= 1) return normalizeSpaces(question);

  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (!FILLER_ONLY_RE.test(part) && part.length >= 6) {
      return part.endsWith("?") ? part : `${part}?`;
    }
  }
  return normalizeSpaces(question);
}

export function guardCurrentQuestion(input: {
  resolvedQuestion: string;
  recentTranscriptWindow?: string[];
}): GuardResult {
  const initial = normalizeSpaces(input.resolvedQuestion);
  if (!initial) {
    return { resolvedCurrentQuestion: "", questionPollutionDetected: false };
  }

  if (FILLER_ONLY_RE.test(initial)) {
    return { resolvedCurrentQuestion: initial, questionPollutionDetected: false };
  }

  let cleaned = initial;
  let polluted = false;

  if (isLikelyPollutedJoin(initial)) {
    cleaned = keepLatestMeaningfulQuestion(initial);
    polluted = cleaned !== initial;
  }

  const transcriptTail = (input.recentTranscriptWindow || []).slice(-4).join(" ");
  if (!polluted && transcriptTail && tokenOverlap(cleaned, transcriptTail) < 0.1 && isLikelyPollutedJoin(cleaned)) {
    const fallback = keepLatestMeaningfulQuestion(cleaned);
    if (fallback && fallback !== cleaned) {
      cleaned = fallback;
      polluted = true;
    }
  }

  return {
    resolvedCurrentQuestion: cleaned,
    questionPollutionDetected: polluted,
  };
}

export function extractCodeBlocksFromText(text: string): string[] {
  if (!text) return [];
  const matches = Array.from(text.matchAll(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g));
  return matches.map((m) => normalizeSpaces(m[1] || "")).filter(Boolean);
}

function deriveTopicFromText(text: string): string {
  const t = normLoose(text);
  if (/\b(sql|postgres|postgresql|query|join|table|index)\b/.test(t)) return "sql";
  if (/\b(mongodb|mongo|aggregation|pipeline|nosql)\b/.test(t)) return "mongodb";
  if (/\b(react|jsx|hooks|component)\b/.test(t)) return "react";
  if (/\b(pyspark|spark|datalake|databricks)\b/.test(t)) return "pyspark";
  if (/\b(node|express|api|backend)\b/.test(t)) return "backend";
  return "general";
}

export function deriveTopic(question: string, previousAiAnswer?: string): string {
  return deriveTopicFromText(`${question || ""} ${previousAiAnswer || ""}`);
}

function scoreTarget(question: string, currentTopic: string, entry: AnswerHistoryEntry): number {
  let score = 0;
  const q = normLoose(question);
  if (entry.codeBlocks.length > 0) score += 2;
  if (currentTopic !== "general" && entry.topic === currentTopic) score += 4;
  score += tokenOverlap(q, `${entry.question} ${entry.answer}`) * 5;
  if (CODE_REF_RE.test(q) && entry.codeBlocks.length > 0) score += 3;
  return score;
}

export function toAnswerHistory(messagesRaw: unknown): AnswerHistoryEntry[] {
  const raw = Array.isArray(messagesRaw) ? messagesRaw as any[] : [];
  return raw
    .filter((m) => m && m.role === "AI_ASSISTANT" && typeof m.answer === "string")
    .map((m, idx) => {
      const answer = String(m.answer || "");
      const question = String(m.question || "");
      const codeBlocks = extractCodeBlocksFromText(answer);
      const timestamp = new Date(m.timestamp || Date.now()).getTime();
      return {
        id: String(m.messageId || m.id || `ai-${idx}`),
        question,
        answer,
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        codeBlocks,
        topic: deriveTopicFromText(`${question} ${answer}`),
        orderIndex: idx,
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((entry, idx) => ({ ...entry, orderIndex: idx }));
}

export function resolveFollowupTarget(input: {
  question: string;
  history: AnswerHistoryEntry[];
  selectedAnswerId?: string;
  selectedAnswerQuestion?: string;
  selectedAnswerText?: string;
  selectedAnswerCodeBlocks?: string[];
  selectedAnswerTopic?: string;
}): FollowupTargetResult {
  const q = normalizeSpaces(input.question);
  const isExplicitFollowupReference =
    CODE_REF_RE.test(q) || FOLLOWUP_RE.test(q) || VAGUE_DEICTIC_RE.test(q);
  const isVagueDeictic = VAGUE_DEICTIC_RE.test(q);
  const history = input.history;
  const selectedAnswerId = input.selectedAnswerId?.trim();
  const selectedAnswerText = input.selectedAnswerText?.trim();
  const selectedAnswerQuestion = input.selectedAnswerQuestion?.trim();
  const selectedAnswerCodeBlocks = (input.selectedAnswerCodeBlocks || []).filter(Boolean);
  const selectedAnswerTopic = input.selectedAnswerTopic?.trim();

  if (!isExplicitFollowupReference) {
    return {
      target: null,
      source: "none",
      isExplicitFollowupReference: false,
      reasonForNoTarget: "fresh_question_no_followup_reference",
      ...(selectedAnswerId
        ? { selectedAnswerIgnoredReason: "fresh_question_no_followup_reference" }
        : {}),
    };
  }

  if (selectedAnswerId) {
    const exact = history.find((h) => h.id === selectedAnswerId);
    if (exact) {
      return {
        target: exact,
        source: "selected_answer",
        isExplicitFollowupReference: true,
        targetConfidence: 1,
      };
    }

    if (selectedAnswerText || selectedAnswerQuestion || selectedAnswerCodeBlocks.length > 0) {
      const synthetic: AnswerHistoryEntry = {
        id: selectedAnswerId,
        question: selectedAnswerQuestion || "",
        answer: selectedAnswerText || "",
        timestamp: Date.now(),
        codeBlocks: selectedAnswerCodeBlocks.slice(0, 2),
        topic:
          selectedAnswerTopic ||
          deriveTopicFromText(`${selectedAnswerQuestion || ""} ${selectedAnswerText || ""}`),
        orderIndex: Number.MAX_SAFE_INTEGER,
      };
      return {
        target: synthetic,
        source: "selected_answer",
        isExplicitFollowupReference: true,
        targetConfidence: 0.95,
      };
    }
  }

  if (!history.length) {
    return {
      target: null,
      source: "none",
      isExplicitFollowupReference: true,
      reasonForNoTarget: "no_answer_history",
    };
  }

  const currentTopic = deriveTopicFromText(q);
  const wantsCode = CODE_REF_RE.test(q);

  const scored = [...history]
    .map((entry) => ({ entry, score: scoreTarget(q, currentTopic, entry) }))
    .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp);

  if (wantsCode) {
    const bestCode = scored.find(
      (s) => s.entry.codeBlocks.length > 0 && (currentTopic === "general" || s.entry.topic === currentTopic),
    );
    if (bestCode && bestCode.score > HIGH_CONFIDENCE_THRESHOLD) {
      return {
        target: bestCode.entry,
        source: "topic_match",
        isExplicitFollowupReference: true,
        targetConfidence: Math.min(1, bestCode.score / 10),
      };
    }
    const latestCode = [...history].reverse().find((h) => h.codeBlocks.length > 0);
    if (latestCode) {
      return {
        target: latestCode,
        source: "latest_code",
        isExplicitFollowupReference: true,
        targetConfidence: 0.7,
      };
    }
    return {
      target: null,
      source: "none",
      isExplicitFollowupReference: true,
      reasonForNoTarget: "explicit_code_followup_but_no_code_target",
    };
  }

  if (scored[0] && scored[0].score > HIGH_CONFIDENCE_THRESHOLD) {
    return {
      target: scored[0].entry,
      source: "topic_match",
      isExplicitFollowupReference: true,
      targetConfidence: Math.min(1, scored[0].score / 10),
    };
  }

  if (isVagueDeictic) {
    const immediate = history[history.length - 1];
    return {
      target: immediate,
      source: "immediate_previous",
      isExplicitFollowupReference: true,
      targetConfidence: 0.55,
    };
  }

  return {
    target: null,
    source: "none",
    isExplicitFollowupReference: true,
    reasonForNoTarget: "explicit_followup_reference_but_low_confidence_target",
  };
}

export function selectTargetCodeContext(target: AnswerHistoryEntry | null): {
  language: string | null;
  preview: string | null;
  codeBlocks: string[];
  previousAiAnswer: string;
} {
  if (!target) {
    return { language: null, preview: null, codeBlocks: [], previousAiAnswer: "" };
  }

  const selectedBlocks = target.codeBlocks.slice(0, 2).map((b) => b.slice(0, 1200));
  const preview = selectedBlocks[0]?.split("\n").slice(0, 2).join(" ").slice(0, 140) || null;
  const language = (() => {
    const source = (selectedBlocks[0] || "").toLowerCase();
    if (/\bselect\b|\bfrom\b|\bwhere\b/.test(source)) return "sql";
    if (/\bconst\b|\bfunction\b|=>/.test(source)) return "javascript";
    if (/\bdef\b|\bimport\b/.test(source)) return "python";
    return null;
  })();

  return {
    language,
    preview,
    codeBlocks: selectedBlocks,
    previousAiAnswer: target.answer.slice(0, 800),
  };
}

export function shouldSuppressExperienceForQuestion(question: string): boolean {
  const q = normalizeSpaces(question);
  const asksExperience = EXPLICIT_EXPERIENCE_RE.test(q);
  return !asksExperience;
}

export function buildEffectiveLiveContextMetadata(input: {
  metadata?: AIAnswerLiveContextMetadata;
  question: string;
  selectedTarget: AnswerHistoryEntry | null;
}): AIAnswerLiveContextMetadata {
  const base = { ...(input.metadata || {}) };
  const codeContext = selectTargetCodeContext(input.selectedTarget);
  const wantsCodeFollowup = CODE_REF_RE.test(input.question);

  if (wantsCodeFollowup && codeContext.codeBlocks.length > 0) {
    return {
      ...base,
      previousAiAnswer: codeContext.previousAiAnswer,
      previousCodeBlocks: codeContext.codeBlocks,
    };
  }

  return base;
}

export function isCodeFollowupQuestion(question: string): boolean {
  return CODE_REF_RE.test(question || "");
}
