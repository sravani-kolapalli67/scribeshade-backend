import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";

export type QuestionCandidateSource =
  | "patchedTranscript"
  | "currentQuestion"
  | "activeQuestionDetection"
  | "transcript"
  | "backend_reconstruction";

export type QuestionQualityResult = {
  cleanedText: string;
  score: number;
  reasons: string[];
  corrections: string[];
};

export type QuestionReconstructionResult = {
  question: string;
  confidence: number;
  source: QuestionCandidateSource;
  corrections: string[];
  evidence: string[];
  quality: QuestionQualityResult;
};

export type AuthoritativeQuestionResult = QuestionReconstructionResult & {
  originalResolvedQuestion: string;
  frontendConfidenceDowngraded: boolean;
};

type QuestionCandidate = {
  source: QuestionCandidateSource;
  text: string;
};

type SpeakerEntry = {
  speakerType: string;
  content: string;
};

const FILLER_RE =
  /^(hi|hello|hey|okay|ok|yeah|yes|no|right|fine|let'?s start(?: here)?|interview|can you hear me|am i audible)[?.!]*$/i;
const ACTION_RE =
  /\b(what|why|how|when|where|which|who|can|could|would|should|is|are|do|does|did|explain|define|describe|tell me|introduce|walk me|write|implement|design|debug|optimi[sz]e|experience|progress|work done)\b/i;
const BROKEN_STT_RE =
  /\b(by another|that'?s the your|the your|you have candidate|candidate:|user:|\[user\]|\[candidate\])\b/i;
const MID_SENTENCE_START_RE =
  /^(yourself|there|that|this|it|and|also|then|because|where|on|in|with|about|progress)\b/i;

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

export function stripQuestionSpeakerLabels(text: string): string {
  return normalizeSpaces(text)
    .replace(/\[(?:user|candidate|interviewer|assistant|system)\]\s*:\s*/gi, "")
    .replace(/(?:^|[\n\r]+)\s*(?:candidate|user|interviewer|assistant|system)\s*:\s*/gi, " ")
    .replace(/(^|[.!?]\s+)(?:candidate|user|interviewer|assistant|system)\s*:\s*/gi, "$1")
    .trim();
}

function normalizeLoose(text: string): string {
  return normalizeSpaces(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text: string): string[] {
  return normalizeLoose(text).split(" ").filter(Boolean);
}

function hasRepeatedSpeakerLabels(text: string): boolean {
  return /(?:\[(?:user|candidate|interviewer)\]\s*:\s*){2,}|(?:candidate|user)\s*:\s*(?:candidate|user)\s*:/i.test(
    text,
  );
}

function repeatedWordPenalty(text: string): boolean {
  const tokens = words(text);
  if (tokens.length < 8) return false;
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.values()].some((count) => count >= 4);
}

function countFillerLines(text: string): number {
  return text
    .split(/[\n\r]+/)
    .map((line) => stripQuestionSpeakerLabels(line))
    .filter((line) => FILLER_RE.test(line)).length;
}

export function scoreQuestionCandidate(text: string): QuestionQualityResult {
  const rawText = text || "";
  const original = normalizeSpaces(rawText);
  const cleanedText = stripQuestionSpeakerLabels(rawText);
  const tokenCount = words(cleanedText).length;
  const reasons: string[] = [];
  const corrections: string[] = [];
  let score = 0.45;

  if (!cleanedText) {
    return { cleanedText: "", score: 0, reasons: ["empty"], corrections };
  }

  if (ACTION_RE.test(cleanedText)) {
    score += 0.24;
    reasons.push("action_signal");
  }
  if (cleanedText.includes("?")) {
    score += 0.08;
    reasons.push("question_mark");
  }
  if (tokenCount >= 4 && tokenCount <= 28) {
    score += 0.12;
    reasons.push("reasonable_length");
  }
  if (tokenCount > 40) {
    score -= 0.24;
    reasons.push("too_long_for_active_question");
  }
  if (countFillerLines(rawText) > 0) {
    score -= 0.18;
    reasons.push("filler_present");
  }
  if (hasRepeatedSpeakerLabels(original)) {
    score -= 0.28;
    reasons.push("repeated_speaker_labels");
    corrections.push("removed_repeated_speaker_labels");
  }
  if (BROKEN_STT_RE.test(original)) {
    score -= 0.32;
    reasons.push("broken_stt_phrase");
    corrections.push("detected_broken_stt_phrase");
  }
  if (MID_SENTENCE_START_RE.test(cleanedText) && !/^(introduce|tell me|explain|describe|what|how|can|could)\b/i.test(cleanedText)) {
    score -= 0.22;
    reasons.push("mid_sentence_start");
  }
  if (repeatedWordPenalty(cleanedText)) {
    score -= 0.16;
    reasons.push("repeated_terms");
  }
  if (FILLER_RE.test(cleanedText)) {
    score = Math.min(score, 0.15);
    reasons.push("filler_only");
  }

  return {
    cleanedText,
    score: Math.max(0, Math.min(1, Number(score.toFixed(3)))),
    reasons,
    corrections,
  };
}

function pushUnique(lines: string[], line: string): string[] {
  const cleaned = stripQuestionSpeakerLabels(line);
  if (!cleaned || FILLER_RE.test(cleaned)) return lines;
  const loose = normalizeLoose(cleaned);
  const duplicate = lines.some((existing) => normalizeLoose(existing) === loose);
  return duplicate ? lines : [...lines, cleaned];
}

function linesFromRawTranscript(rawTranscript: string): string[] {
  return rawTranscript
    .split(/[\n\r]+/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean);
}

function speakerLines(metadata: AIAnswerLiveContextMetadata | undefined): string[] {
  const entries = (metadata?.speakerSeparatedTranscript || []) as SpeakerEntry[];
  const hasInterviewer = entries.some((entry) => entry.speakerType === "interviewer");
  return entries
    .filter((entry) => !hasInterviewer || entry.speakerType === "interviewer")
    .map((entry) => entry.content);
}

function evidenceLines(input: {
  rawTranscript: string;
  recentTranscriptWindow?: string[];
  metadata?: AIAnswerLiveContextMetadata;
}): string[] {
  let lines: string[] = [];
  for (const line of [
    ...speakerLines(input.metadata),
    ...(input.recentTranscriptWindow || []),
    ...linesFromRawTranscript(input.rawTranscript),
  ]) {
    lines = pushUnique(lines, line);
  }
  return lines.slice(-10);
}

function repairKnownSttPatterns(text: string): { question: string; corrections: string[] } {
  const corrections: string[] = [];
  const cleaned = stripQuestionSpeakerLabels(text)
    .replace(/\bby another\b/gi, "")
    .replace(/\bthat'?s the your\b/gi, "explain your")
    .replace(/\bthe your\b/gi, "your")
    .replace(/\s+/g, " ")
    .trim();
  return { question: cleaned, corrections };
}

export function reconstructFallbackQuestion(input: {
  rawTranscript: string;
  currentQuestionHint?: string;
  activeQuestionHint?: string;
  recentTranscriptWindow?: string[];
  metadata?: AIAnswerLiveContextMetadata;
}): QuestionReconstructionResult {
  const evidence = evidenceLines({
    rawTranscript: input.rawTranscript,
    recentTranscriptWindow: input.recentTranscriptWindow,
    metadata: input.metadata,
  });
  const mergedEvidence = normalizeSpaces(evidence.join(" "));
  const hint = normalizeSpaces(input.currentQuestionHint || input.activeQuestionHint || "");
  const sourceText = normalizeSpaces(`${mergedEvidence} ${hint}`) || input.rawTranscript || hint;
  const repaired = repairKnownSttPatterns(sourceText);
  const quality = scoreQuestionCandidate(repaired.question);
  const fallbackQuestion = quality.cleanedText;
  return {
    question: fallbackQuestion,
    confidence: Math.max(0.35, Math.min(0.82, quality.score + 0.12)),
    source: "backend_reconstruction",
    corrections: [...new Set([...repaired.corrections, ...quality.corrections])],
    evidence,
    quality,
  };
}

export function resolveAuthoritativeQuestion(input: {
  patchedTranscript?: string;
  currentQuestion?: string;
  transcript: string;
  metadata?: AIAnswerLiveContextMetadata;
  isCustomQuery: boolean;
}): AuthoritativeQuestionResult {
  const activeQuestion = input.metadata?.activeQuestionDetection?.activeQuestion || "";
  const cleanedQuestion = input.metadata?.activeQuestionDetection?.cleanedQuestion || "";
  const rawCandidates: QuestionCandidate[] = [
    { source: "patchedTranscript", text: input.patchedTranscript || "" },
    { source: "currentQuestion", text: input.currentQuestion || "" },
    { source: "activeQuestionDetection", text: cleanedQuestion || activeQuestion },
    { source: "transcript", text: input.transcript },
  ];
  const candidates = rawCandidates.filter((candidate) => normalizeSpaces(candidate.text));

  const scored = candidates.map((candidate) => ({
    candidate,
    quality: scoreQuestionCandidate(candidate.text),
  }));
  const explicitManual = input.isCustomQuery
    ? scored.find((entry) => entry.candidate.source === "currentQuestion")
    : undefined;
  const explicitPatch = scored.find((entry) => entry.candidate.source === "patchedTranscript");
  const preferred =
    explicitPatch ||
    explicitManual ||
    scored
      .filter((entry) => entry.quality.score >= 0.58)
      .sort((a, b) => b.quality.score - a.quality.score)[0];

  const reconstruction = reconstructFallbackQuestion({
    rawTranscript: input.transcript,
    currentQuestionHint: input.currentQuestion,
    activeQuestionHint: cleanedQuestion || activeQuestion,
    recentTranscriptWindow: input.metadata?.recentTranscriptWindow,
    metadata: input.metadata,
  });
  const selected =
    preferred && preferred.quality.score >= reconstruction.quality.score
      ? {
          question: preferred.quality.cleanedText,
          confidence: preferred.quality.score,
          source: preferred.candidate.source,
          corrections: preferred.quality.corrections,
          evidence: [],
          quality: preferred.quality,
        }
      : reconstruction;
  const frontendConfidence = input.metadata?.activeQuestionDetection?.confidenceScore;
  const frontendQuestionQuality = scored
    .filter((entry) =>
      entry.candidate.source === "currentQuestion" ||
      entry.candidate.source === "activeQuestionDetection",
    )
    .sort((a, b) => b.quality.score - a.quality.score)[0]?.quality;

  return {
    ...selected,
    originalResolvedQuestion: input.transcript,
    frontendConfidenceDowngraded:
      typeof frontendConfidence === "number" &&
      frontendConfidence >= 0.9 &&
      (selected.source === "backend_reconstruction" ||
        (frontendQuestionQuality?.score ?? 1) < 0.58),
  };
}
