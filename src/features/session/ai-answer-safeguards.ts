import type { AnswerValidationResult } from "./session-intelligence.types";
import type { AnswerTrust } from "./session-intelligence.types";

export type { AnswerValidationResult } from "./session-intelligence.types";

export type ExtractedAnswerPair = {
  question: string;
  answer: string;
};

const SEGMENT_MARKER_RE = /\n?={3,}NEXT_QUESTION={3,}\n?/i;
const QUESTION_LABEL_RE = /\*?\*?QUESTION:\*?\*?/gi;
const TEXT_FENCE_LANGUAGE_RE = /^(text|txt|plain|plaintext|ascii|mermaid|flow)$/i;
const CODE_FENCE_LANGUAGE_RE =
  /^(ts|tsx|typescript|js|jsx|javascript|py|python|sql|java|c|cpp|csharp|cs|go|rust|rs|php|rb|ruby|swift|kt|kotlin|scala|sh|bash|zsh|html|css|json|yaml|yml)$/i;
const CODE_LIKE_FENCE_BODY_RE =
  /\b(const|let|var|function|class|def|import|export|return|select|from|where|join|public|private|interface|type|struct|fn|async|await)\b|=>|[{};]/i;

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function normalizeEvidenceKeyText(text: string): string {
  return normalizeSpaces(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function evidenceTokens(text: string): string[] {
  const stopwords = new Set([
    "the",
    "and",
    "you",
    "your",
    "can",
    "could",
    "would",
    "please",
    "about",
    "more",
    "details",
    "specific",
    "with",
    "that",
    "this",
    "have",
    "done",
    "what",
    "how",
    "why",
    "when",
    "where",
  ]);
  return normalizeEvidenceKeyText(text)
    .replace(/\?/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !stopwords.has(token));
}

function isQuestionStronglySupportedByEvidence(question: string, evidenceText: string): boolean {
  const normalizedQuestion = normalizeEvidenceKeyText(question);
  const normalizedEvidence = normalizeEvidenceKeyText(evidenceText);
  if (!normalizedQuestion || !normalizedEvidence) return false;
  if (normalizedEvidence.includes(normalizedQuestion)) return true;

  const questionTokens = evidenceTokens(question);
  if (questionTokens.length < 3) return false;
  const evidenceTokenSet = new Set(evidenceTokens(evidenceText));
  const overlapCount = questionTokens.filter((token) => evidenceTokenSet.has(token)).length;
  return overlapCount / questionTokens.length >= 0.75;
}

function fencedBlocks(text: string): Array<{ language: string; body: string }> {
  return Array.from((text || "").matchAll(/```([^\n`]*)\n?([\s\S]*?)```/g)).map((match) => ({
    language: normalizeSpaces(match[1] || "").toLowerCase(),
    body: match[2] || "",
  }));
}

function hasDisallowedCodeFence(text: string, allowFencedBlocks: boolean): boolean {
  if (allowFencedBlocks) return false;
  return fencedBlocks(text).some((block) => {
    if (TEXT_FENCE_LANGUAGE_RE.test(block.language)) return false;
    if (CODE_FENCE_LANGUAGE_RE.test(block.language)) return true;
    return CODE_LIKE_FENCE_BODY_RE.test(block.body);
  });
}

function hasStaleContextReference(input: {
  answer: string;
  evidenceText: string;
  questionAllowsCode: boolean;
}): boolean {
  if (/\b(selected answer|previous answer|above answer|as i said earlier|as mentioned earlier|earlier answer)\b/i.test(input.answer)) {
    return true;
  }
  if (input.questionAllowsCode) return false;
  const evidence = normalizeEvidenceKeyText(input.evidenceText);
  if (/\breact\s+useref\b/i.test(input.answer) && !evidence.includes("react useref")) return true;
  if (/\buseeffect\s+hook\b/i.test(input.answer) && !evidence.includes("useeffect")) return true;
  return false;
}

export function shouldScheduleBackgroundComposer(envValue: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((envValue || "").trim().toLowerCase());
}

export function filterPersistableAnswerPairs(input: {
  pairs: ExtractedAnswerPair[];
  evidenceText: string;
  sessionId?: string;
}): ExtractedAnswerPair[] {
  if (input.pairs.length <= 1) return input.pairs;
  const [firstPair, ...extraPairs] = input.pairs;
  const supportedPairs = extraPairs.filter((pair) => {
    const supported = isQuestionStronglySupportedByEvidence(pair.question, input.evidenceText);
    if (!supported) {
      console.warn("[AI Answer] dropped unsupported generated question", {
        sessionId: input.sessionId,
        question: pair.question,
      });
    }
    return supported;
  });
  return [firstPair, ...supportedPairs];
}

export function selectPersistableAnswerPairs(input: {
  finalResponse: string;
  pairs: ExtractedAnswerPair[];
  evidenceText: string;
  sessionId?: string;
}): ExtractedAnswerPair[] {
  if (SEGMENT_MARKER_RE.test(input.finalResponse)) {
    return input.pairs;
  }
  return filterPersistableAnswerPairs({
    pairs: input.pairs,
    evidenceText: input.evidenceText,
    sessionId: input.sessionId,
  });
}

export function validateAnswerForMemory(input: {
  finalResponse: string;
  pair: ExtractedAnswerPair;
  evidenceText: string;
  runtimeContextText?: string;
  questionAllowsCode: boolean;
  allowFencedBlocks?: boolean;
  skipUnsupportedQuestionEvidenceCheck?: boolean;
  staleContextCleared: boolean;
  scenarioNumbers?: string[];
  requestedTrust?: AnswerTrust;
}): AnswerValidationResult {
  const reasons: string[] = [];
  const response = input.finalResponse || "";
  const answer = input.pair.answer || "";
  const questionBlocks = response.match(QUESTION_LABEL_RE) || [];

  if (response.trim() === "===NO_NEW_QUESTION===") {
    reasons.push("no_new_question_sentinel");
  }
  if (questionBlocks.length > 1 && !SEGMENT_MARKER_RE.test(response)) {
    reasons.push("unsupported_extra_question_without_separator");
  }
  if (
    input.pair.question &&
    input.evidenceText &&
    input.skipUnsupportedQuestionEvidenceCheck !== true &&
    !isQuestionStronglySupportedByEvidence(input.pair.question, input.evidenceText) &&
    questionBlocks.length > 1
  ) {
    reasons.push("question_not_supported_by_evidence");
  }
  if (!input.questionAllowsCode && hasDisallowedCodeFence(answer, input.allowFencedBlocks === true)) {
    reasons.push("code_block_without_code_request");
  }
  if (
    input.staleContextCleared &&
    hasStaleContextReference({
      answer,
      evidenceText: input.evidenceText,
      questionAllowsCode: input.questionAllowsCode,
    })
  ) {
    reasons.push("stale_context_reference_after_clear");
  }
  const missingScenarioNumbers = (input.scenarioNumbers || [])
    .filter((number) => /\d/.test(number))
    .filter((number) => !answer.includes(number));
  if (missingScenarioNumbers.length > 0 && input.scenarioNumbers && input.scenarioNumbers.length > 0) {
    reasons.push(`scenario_numbers_not_preserved:${missingScenarioNumbers.slice(0, 4).join(",")}`);
  }
  const blockingReasons = new Set([
    "no_new_question_sentinel",
    "question_not_supported_by_evidence",
    "code_block_without_code_request",
    "stale_context_reference_after_clear",
  ]);
  const persistCard = !reasons.some((reason) => blockingReasons.has(reason));
  const weakEvidence = reasons.some(
    (reason) =>
      reason.startsWith("scenario_numbers_not_preserved") ||
      reason === "unsupported_extra_question_without_separator",
  );
  const trust = !persistCard
    ? "none"
    : input.requestedTrust === "none"
      ? "none"
      : input.requestedTrust === "weak" || weakEvidence
        ? "weak"
        : "strong";
  return {
    persistCard,
    updateMemory: trust === "strong",
    trust,
    reasons,
  };
}
