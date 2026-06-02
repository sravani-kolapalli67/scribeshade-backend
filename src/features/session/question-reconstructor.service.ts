import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";
import type { NormalizedTranscriptBlock } from "./transcript-normalizer.service";
import type { ActiveTopicMemory } from "./topic-memory.service";
import {
  classifyConversationIntent,
  deriveTopicFromAnyText,
  type ConversationIntent,
} from "./answer-quality";

export type ReconstructedQuestionIntent =
  | "technical_concept"
  | "code_generation"
  | "code_followup"
  | "scenario_based"
  | "system_design"
  | "behavioral"
  | "project_explanation"
  | "noise";

export type ReconstructedQuestion = {
  displayQuestion: string;
  llmQuestion: string;
  rawEvidence: string[];
  isFollowUp: boolean;
  followupTargetId?: string;
  topicId: string;
  topicChanged: boolean;
  intent: ReconstructedQuestionIntent;
  confidence: number;
  shouldAnswer: boolean;
  reason?: string;
};

type ReconstructQuestionInput = {
  normalizedBlocks: NormalizedTranscriptBlock[];
  fallbackQuestion: string;
  metadata?: AIAnswerLiveContextMetadata;
  activeTopic: ActiveTopicMemory | null;
};

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function isQuestionLike(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (cleaned.includes("?")) return true;
  return /^(what|why|how|when|where|which|who|can|could|would|should|is|are|do|does|did|explain|define|write|implement|design|debug|optimi[sz]e)\b/i.test(
    cleaned,
  );
}

function isNoise(text: string): boolean {
  const cleaned = normalizeSpaces(text).toLowerCase();
  if (!cleaned) return true;
  return /^(hi|hello|hey|okay|ok|yes|no|right|fine|thank you|thanks|can you hear me|am i audible)$/.test(
    cleaned,
  );
}

function chooseEvidence(blocks: NormalizedTranscriptBlock[], fallbackQuestion: string): string[] {
  const interviewer = blocks
    .filter((block) => block.speakerType === "INTERVIEWER")
    .map((block) => block.correctedText)
    .filter(Boolean);
  if (interviewer.length > 0) return interviewer.slice(-6);

  const unknown = blocks.map((block) => block.correctedText).filter(Boolean);
  if (unknown.length > 0) return unknown.slice(-6);

  const fallback = normalizeSpaces(fallbackQuestion);
  return fallback ? [fallback] : [];
}

function mapIntent(intent: ConversationIntent, question: string): ReconstructedQuestionIntent {
  const normalized = question.toLowerCase();
  if (intent === "EXPLAIN_CODE" || intent === "DEBUG_CODE" || intent === "OPTIMIZE_CODE") {
    return "code_followup";
  }
  if (/\b(write|implement|create|build)\b.{0,30}\b(code|function|api|query|snippet)\b/i.test(question)) {
    return "code_generation";
  }
  if (intent === "SCENARIO_QUESTION") return "scenario_based";
  if (/\b(system design|design a|architecture|scalability|distributed)\b/i.test(question)) {
    return "system_design";
  }
  if (intent === "EXPERIENCE_QUESTION") {
    return /\b(project|projects|architecture|tech stack)\b/i.test(normalized)
      ? "project_explanation"
      : "behavioral";
  }
  if (intent === "UNKNOWN") return "noise";
  return "technical_concept";
}

function reconstructFollowupQuestion(input: {
  question: string;
  isFollowUp: boolean;
  activeTopic: ActiveTopicMemory | null;
}): string {
  const question = normalizeSpaces(input.question);
  if (!question || !input.isFollowUp || !input.activeTopic) return question;
  const topicTitle = normalizeSpaces(input.activeTopic.topicTitle);
  if (!topicTitle || topicTitle === "general") return question;
  if (new RegExp(`\\b${topicTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(question)) {
    return question;
  }
  return `${question} (follow-up about ${topicTitle})`;
}

export function reconstructQuestion(
  input: ReconstructQuestionInput,
): ReconstructedQuestion {
  const detection = input.metadata?.activeQuestionDetection;
  const evidence = chooseEvidence(input.normalizedBlocks, input.fallbackQuestion);
  const evidenceQuestion = normalizeSpaces(evidence.join(" "));
  const detectionQuestion = normalizeSpaces(detection?.cleanedQuestion || "");
  const fallback = normalizeSpaces(input.fallbackQuestion);
  const displayQuestion = detectionQuestion || evidenceQuestion || fallback;
  const conversationIntent = classifyConversationIntent(displayQuestion);
  const isFollowUp =
    !!detection?.isFollowUp ||
    ["FOLLOW_UP", "CONTINUE_PREVIOUS", "EXPLAIN_CODE", "DEBUG_CODE", "OPTIMIZE_CODE", "SCENARIO_QUESTION"].includes(
      conversationIntent,
    );
  const llmQuestion = reconstructFollowupQuestion({
    question: displayQuestion,
    isFollowUp,
    activeTopic: input.activeTopic,
  });
  const intent = detection?.ignoredNoise || isNoise(displayQuestion)
    ? "noise"
    : mapIntent(conversationIntent, displayQuestion);
  const confidence = clampConfidence(
    detection?.confidenceScore ??
      (input.normalizedBlocks.length > 0
        ? Math.max(...input.normalizedBlocks.map((block) => block.confidence))
        : 0.55),
  );
  const topicTitle = deriveTopicFromAnyText(`${displayQuestion} ${input.activeTopic?.topicTitle || ""}`);
  const hasQuestionSignal = isQuestionLike(displayQuestion) || isFollowUp;
  const shouldAnswer =
    !detection?.ignoredNoise &&
    intent !== "noise" &&
    hasQuestionSignal &&
    confidence >= 0.45;

  return {
    displayQuestion,
    llmQuestion,
    rawEvidence: evidence,
    isFollowUp,
    followupTargetId: detection?.referencedHistoryTurnId,
    topicId: topicTitle || "general",
    topicChanged: !!detection?.topicChanged,
    intent,
    confidence,
    shouldAnswer,
    reason: shouldAnswer ? undefined : "unclear_transcript",
  };
}
