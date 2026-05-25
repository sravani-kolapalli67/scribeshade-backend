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
  originalResolvedQuestion: string;
  reconstructedResolvedQuestion: string;
  weakQuestionReconstructedBackend: boolean;
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

export type ConversationIntent =
  | "NEW_QUESTION"
  | "FOLLOW_UP"
  | "CONTINUE_PREVIOUS"
  | "EXPLAIN_CODE"
  | "DEBUG_CODE"
  | "OPTIMIZE_CODE"
  | "EXPERIENCE_QUESTION"
  | "SCENARIO_QUESTION"
  | "INTERVIEW_INSTRUCTION"
  | "UNKNOWN";

const FILLER_ONLY_RE = /^(hi|hello|hey|can you hear me|am i audible|okay|ok|hmm|huh|right|fine)$/i;
const EXPLICIT_EXPERIENCE_RE =
  /\b(your experience|your project|your company|tell me about your project|from your project|in your company|in your project|where have you used|how have you used|years? of experience|how many years|professional experience|work experience|project details?|your role|responsibilit(?:y|ies)|measurable impact|impact metrics?|numbers?|tech stack)\b/i;
const CODE_REF_RE =
  /\b(this code|the code|your code|the code you wrote|above code|previous code|first line|that query|the query|query you wrote|query you wrote before|that code|what does this code do|explain (?:it|the code again)|explain (?:this|that|the|your|previous|above)\s+(?:code|query|snippet|function|logic)|why (?:is|was) this used|why did you use this|optimi[sz]e (?:this|it|the code|the query)?|debug (?:this|it|the code|the query)?|fix (?:this|it|the code|the query)?|previous answer|above answer)\b/i;
const FOLLOWUP_RE =
  /\b(explain this|explain that|explain the code again|expand on that|can you expand|can you explain more|can you explain that|tell me more about that|tell me more|why did you use this|why this is used|why|how exactly|same thing|continue(?: from)?|continue from .{1,80}|what about that|what does this mean|previous answer|above answer|before|you wrote|you said|you mentioned|in your previous project|previously you said|the approach|that approach|repeat the answer|what did you say|database part|architecture part|from the (?:database|backend|frontend|api|architecture|deployment|security|scaling) part)\b/i;
const VAGUE_DEICTIC_RE =
  /^(?:that|this|it|that approach|this approach|explain it|explain that|explain this|explain the code|can you explain that|can you explain this|continue|continue from .{1,80}|tell me more|tell me more about that|why\??|why this is used\??|how so\??|how exactly did you do that\??|elaborate|expand|optimi[sz]e this|debug this)\s*$/i;
const DEBUG_FOLLOWUP_RE = /\b(debug|fix|bug|error|issue|failing|not working)\b/i;
const OPTIMIZE_FOLLOWUP_RE = /\b(optimi[sz]e|improve performance|make (?:this|it) faster|refactor)\b/i;
const SCENARIO_FOLLOWUP_RE =
  /\b(scenario|suppose|imagine|case where|incident|outage|production|architecture|system design|continue from (?:database|backend|frontend|api|architecture|deployment|security|scaling) part|database part|tradeoff|trade-off|next step)\b/i;
const INTERVIEW_INSTRUCTION_RE =
  /\b(answer this|give me an answer|how should i answer|what should i say|interviewer is asking|define this|explain this for interview)\b/i;
const HIGH_CONFIDENCE_THRESHOLD = 1.5;
const STRONG_TOPIC_TERMS = [
  "mongodb",
  "mongo",
  "mongoose",
  "sql",
  "postgres",
  "postgresql",
  "query",
  "code",
  "function",
  "api",
  "backend",
  "frontend",
  "database",
  "architecture",
  "user event",
  "user events",
  "event logs",
  "tracking",
  "project",
  "previous",
  "mentioned",
  "approach",
  "analytics",
];

const TRANSCRIPT_CORRECTIONS: Array<[RegExp, string]> = [
  [/\bpostgre\s+sequel\b|\bpostgress\b|\bpostgres\b|\bpostgre\s*sql\b/gi, "PostgreSQL"],
  [/\bmy\s+sequel\b/gi, "MySQL"],
  [/\bmongo\s+db\b/gi, "MongoDB"],
  [/\bnode\s+js\b/gi, "Node.js"],
  [/\bexpress\s+js\b/gi, "Express.js"],
  [/\breact\s+js\b/gi, "React.js"],
  [/\btype\s*script\b/gi, "TypeScript"],
  [/\bjava\s*script\b/gi, "JavaScript"],
  [/\brest\s+api\b/gi, "REST API"],
  [/\bci\s+cd\b/gi, "CI/CD"],
  [/\bkuber\s*net(?:es|is)\b/gi, "Kubernetes"],
];

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

export function normalizeTranscriptForQuestionDetection(text: string): string {
  if (!text) return "";
  const protectedSegmentRe = /(```[\s\S]*?```|`[^`]*`|"[^"]*"|'[^']*'|\/[^\s`"']+)/g;
  const isProtectedSegment = (segment: string) =>
    /^```[\s\S]*```$/.test(segment) ||
    /^`[^`]*`$/.test(segment) ||
    /^"[^"]*"$/.test(segment) ||
    /^'[^']*'$/.test(segment) ||
    /^\/[^\s`"']+$/.test(segment);
  return text
    .split(protectedSegmentRe)
    .map((segment) => {
      if (!segment || isProtectedSegment(segment)) {
        return segment;
      }
      return TRANSCRIPT_CORRECTIONS.reduce(
        (next, [pattern, replacement]) => next.replace(pattern, replacement),
        segment,
      );
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function normLoose(text: string): string {
  return normalizeSpaces(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  return normLoose(text).split(" ").filter(Boolean);
}

function hasStrongTopicTerms(text: string): boolean {
  const n = normLoose(text);
  if (!n) return false;
  return STRONG_TOPIC_TERMS.some((t) => n.includes(t));
}

function isWeakDeicticQuestion(text: string): boolean {
  const n = normLoose(text);
  if (!n) return false;
  return /^(that|this|it|that approach|this approach|explain that|explain this|explain the code|can you explain that|can you explain this|tell me more|tell me more about that|explain it|how so|why|why this is used|continue|continue from .{1,80}|optimize this|debug this)\??$/.test(
    n,
  );
}

export function classifyConversationIntent(question: string): ConversationIntent {
  const q = normalizeTranscriptForQuestionDetection(question);
  const n = normLoose(q);
  if (!n) return "UNKNOWN";
  if (FILLER_ONLY_RE.test(q)) return "UNKNOWN";
  if (CODE_REF_RE.test(q)) {
    if (DEBUG_FOLLOWUP_RE.test(q)) return "DEBUG_CODE";
    if (OPTIMIZE_FOLLOWUP_RE.test(q)) return "OPTIMIZE_CODE";
    return "EXPLAIN_CODE";
  }
  if (/^continue\b/i.test(q) || VAGUE_DEICTIC_RE.test(q)) return "CONTINUE_PREVIOUS";
  if (EXPLICIT_EXPERIENCE_RE.test(q)) return "EXPERIENCE_QUESTION";
  if (SCENARIO_FOLLOWUP_RE.test(q)) return "SCENARIO_QUESTION";
  if (FOLLOWUP_RE.test(q)) return "FOLLOW_UP";
  if (INTERVIEW_INSTRUCTION_RE.test(q)) return "INTERVIEW_INSTRUCTION";
  if (/^(what|why|how|when|where|which|who|can|could|would|should|is|are|do|does|did|explain|define|write|implement|design)\b/i.test(q)) {
    return "NEW_QUESTION";
  }
  return "UNKNOWN";
}

export function isFollowupConversationIntent(intent: ConversationIntent): boolean {
  return (
    intent === "FOLLOW_UP" ||
    intent === "CONTINUE_PREVIOUS" ||
    intent === "EXPLAIN_CODE" ||
    intent === "DEBUG_CODE" ||
    intent === "OPTIMIZE_CODE" ||
    intent === "SCENARIO_QUESTION"
  );
}

function reconstructWeakFollowupFromTranscript(
  currentQuestion: string,
  recentTranscriptWindow?: string[],
): { reconstructed: string; chunksUsed: string[] } {
  const question = normalizeSpaces(currentQuestion);
  const chunks = (recentTranscriptWindow || [])
    .slice(-10)
    .map((line) => normalizeSpaces(line.replace(/^\[[^\]]+\]:\s*/, "")))
    .filter(Boolean);
  const deduped: string[] = [];
  for (const c of chunks) {
    const isDup = deduped.some((d) => tokenOverlap(d, c) >= 0.9);
    if (!isDup) deduped.push(c);
  }
  const scored = deduped.map((chunk) => {
    const n = normLoose(chunk);
    let score = 0;
    for (const term of STRONG_TOPIC_TERMS) {
      if (n.includes(term)) score += 2;
    }
    if (chunk.includes("?")) score += 1;
    return { chunk, score };
  });
  const relevant = [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .sort((a, b) => deduped.indexOf(a.chunk) - deduped.indexOf(b.chunk))
    .map((x) => x.chunk);
  const merged = normalizeSpaces(relevant.join(" "));
  if (!merged) return { reconstructed: question, chunksUsed: relevant };
  const suffix = question.endsWith("?") ? question : `${question}?`;
  const reconstructed = /(\bthat\b|\bthis\b|\bapproach\b)/i.test(question)
    ? normalizeSpaces(`${merged.replace(/[?]+$/g, "")}. ${suffix}`)
    : merged;
  return { reconstructed, chunksUsed: relevant };
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
  const initial = normalizeSpaces(normalizeTranscriptForQuestionDetection(input.resolvedQuestion));
  if (!initial) {
    return {
      resolvedCurrentQuestion: "",
      originalResolvedQuestion: "",
      reconstructedResolvedQuestion: "",
      weakQuestionReconstructedBackend: false,
      questionPollutionDetected: false,
    };
  }

  if (FILLER_ONLY_RE.test(initial)) {
    return {
      resolvedCurrentQuestion: initial,
      originalResolvedQuestion: initial,
      reconstructedResolvedQuestion: initial,
      weakQuestionReconstructedBackend: false,
      questionPollutionDetected: false,
    };
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

  let weakQuestionReconstructedBackend = false;
  if (isWeakDeicticQuestion(cleaned) && hasStrongTopicTerms(transcriptTail)) {
    const rebuilt = reconstructWeakFollowupFromTranscript(cleaned, input.recentTranscriptWindow);
    if (rebuilt.reconstructed && rebuilt.reconstructed !== cleaned) {
      cleaned = rebuilt.reconstructed;
      weakQuestionReconstructedBackend = true;
    }
  }

  return {
    resolvedCurrentQuestion: cleaned,
    originalResolvedQuestion: initial,
    reconstructedResolvedQuestion: cleaned,
    weakQuestionReconstructedBackend,
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
  if (/\b(mongoose|mongodb|mongo|aggregation|pipeline|nosql|collection|schema|event logs?|user events?)\b/.test(t)) return "mongodb";
  if (/\b(sql|postgres|postgresql|select|query|join|table|index)\b/.test(t)) return "sql";
  if (/\b(react|jsx|hooks|component)\b/.test(t)) return "react";
  if (/\b(pyspark|spark|datalake|databricks)\b/.test(t)) return "pyspark";
  if (/\b(node|express|api|backend)\b/.test(t)) return "backend";
  return "general";
}

export function deriveTopicFromAnyText(text: string): string {
  return deriveTopicFromText(text);
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

function hasExplicitSelectedAnswerReference(question: string): boolean {
  return /\b(this answer|that answer|selected answer|this card|that card|above answer)\b/i.test(
    question || "",
  );
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
  const q = normalizeSpaces(normalizeTranscriptForQuestionDetection(input.question));
  const isExplicitFollowupReference =
    CODE_REF_RE.test(q) || FOLLOWUP_RE.test(q) || VAGUE_DEICTIC_RE.test(q);
  const isVagueDeictic = VAGUE_DEICTIC_RE.test(q);
  const history = input.history;
  const selectedAnswerId = input.selectedAnswerId?.trim();
  const selectedAnswerText = input.selectedAnswerText?.trim();
  const selectedAnswerQuestion = input.selectedAnswerQuestion?.trim();
  const selectedAnswerCodeBlocks = (input.selectedAnswerCodeBlocks || []).filter(Boolean);
  const selectedAnswerTopic = input.selectedAnswerTopic?.trim();
  const explicitSelectedAnswerReference = hasExplicitSelectedAnswerReference(q);
  let selectedAnswerIgnoredReason: string | undefined;

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
    const currentTopicForSelected = deriveTopicFromText(q);
    const selectedTopicExact = exact?.topic || selectedAnswerTopic || "";
    const selectedTextExact = `${exact?.question || selectedAnswerQuestion || ""} ${exact?.answer || selectedAnswerText || ""}`;
    const selectedOverlapExact = tokenOverlap(q, selectedTextExact);
    const selectedTopicCompatibleExact =
      explicitSelectedAnswerReference ||
      currentTopicForSelected === "general" ||
      !selectedTopicExact ||
      selectedTopicExact === currentTopicForSelected ||
      selectedOverlapExact >= 0.2;
    if (exact) {
      if (!selectedTopicCompatibleExact) {
        selectedAnswerIgnoredReason = "topic_mismatch";
      } else {
        return {
          target: exact,
          source: "selected_answer",
          isExplicitFollowupReference: true,
          targetConfidence: 1,
        };
      }
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
      const selectedTextSynthetic = `${synthetic.question} ${synthetic.answer}`;
      const selectedOverlapSynthetic = tokenOverlap(q, selectedTextSynthetic);
      const selectedTopicCompatibleSynthetic =
        explicitSelectedAnswerReference ||
        currentTopicForSelected === "general" ||
        !synthetic.topic ||
        synthetic.topic === currentTopicForSelected ||
        selectedOverlapSynthetic >= 0.2;
      if (!selectedTopicCompatibleSynthetic) {
        selectedAnswerIgnoredReason = "topic_mismatch";
      } else {
        return {
          target: synthetic,
          source: "selected_answer",
          isExplicitFollowupReference: true,
          targetConfidence: 0.95,
        };
      }
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
        ...(selectedAnswerIgnoredReason ? { selectedAnswerIgnoredReason } : {}),
        targetConfidence: Math.min(1, bestCode.score / 10),
      };
    }
    const latestCode = [...history].reverse().find((h) => h.codeBlocks.length > 0);
    if (latestCode) {
      return {
        target: latestCode,
        source: "latest_code",
        isExplicitFollowupReference: true,
        ...(selectedAnswerIgnoredReason ? { selectedAnswerIgnoredReason } : {}),
        targetConfidence: 0.7,
      };
    }
    return {
      target: null,
      source: "none",
      isExplicitFollowupReference: true,
      ...(selectedAnswerIgnoredReason ? { selectedAnswerIgnoredReason } : {}),
      reasonForNoTarget: "explicit_code_followup_but_no_code_target",
    };
  }

  if (scored[0] && scored[0].score > HIGH_CONFIDENCE_THRESHOLD) {
    return {
      target: scored[0].entry,
      source: "topic_match",
      isExplicitFollowupReference: true,
      ...(selectedAnswerIgnoredReason ? { selectedAnswerIgnoredReason } : {}),
      targetConfidence: Math.min(1, scored[0].score / 10),
    };
  }

  if (isVagueDeictic) {
    const immediate = history[history.length - 1];
    return {
      target: immediate,
      source: "immediate_previous",
      isExplicitFollowupReference: true,
      ...(selectedAnswerIgnoredReason ? { selectedAnswerIgnoredReason } : {}),
      targetConfidence: 0.55,
    };
  }

  return {
    target: null,
    source: "none",
    isExplicitFollowupReference: true,
    ...(selectedAnswerIgnoredReason ? { selectedAnswerIgnoredReason } : {}),
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
