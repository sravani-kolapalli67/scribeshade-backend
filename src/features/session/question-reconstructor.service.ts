import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";
import type { NormalizedTranscriptBlock } from "./transcript-normalizer.service";
import type { ActiveTopicMemory } from "./topic-memory.service";
import {
  classifyConversationIntent,
  deriveTopicFromAnyText,
  stripLeadingConjunctionsAndFillers,
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
  const stripped = stripLeadingConjunctionsAndFillers(cleaned);
  return /^(what|why|how|when|where|which|who|can|could|would|should|is|are|do|does|did|explain|define|describe|tell me|introduce|walk me|write|implement|design|debug|optimi[sz]e)\b/i.test(
    stripped,
  );
}

function isNoise(text: string): boolean {
  const cleaned = normalizeSpaces(text).toLowerCase();
  if (!cleaned) return true;
  return /^(hi|hello|hey|okay|ok|yes|no|right|fine|thank you|thanks|can you hear me|am i audible)$/.test(
    cleaned,
  );
}

function hasFollowupAnchor(input: {
  detection?: AIAnswerLiveContextMetadata["activeQuestionDetection"];
  metadata?: AIAnswerLiveContextMetadata;
  activeTopic: ActiveTopicMemory | null;
}): boolean {
  return Boolean(
    input.activeTopic ||
      input.detection?.referencedHistoryTurnId ||
      input.metadata?.selectedAnswerId ||
      input.metadata?.selectedAnswerText ||
      input.metadata?.previousAiAnswer ||
      (input.metadata?.previousAiAnswers && input.metadata.previousAiAnswers.length > 0),
  );
}

function answerabilityReason(input: {
  displayQuestion: string;
  intent: ReconstructedQuestionIntent;
  confidence: number;
  isFollowUp: boolean;
  hasAnchor: boolean;
  detectionIgnoredNoise: boolean;
}): string | undefined {
  if (input.detectionIgnoredNoise || input.intent === "noise" || isNoise(input.displayQuestion)) {
    return "low_confidence_noise";
  }
  const wordCount = input.displayQuestion.split(/\s+/).filter(Boolean).length;
  const hasQuestionSignal = isQuestionLike(input.displayQuestion) || wordCount >= 4;
  if (!hasQuestionSignal || input.confidence < 0.25) {
    return "unclear_transcript";
  }
  if (input.isFollowUp && !input.hasAnchor && wordCount <= 4) {
    return "missing_followup_target";
  }
  return undefined;
}

function shouldUseEvidenceOverDetection(input: {
  detectionQuestion: string;
  evidenceQuestion: string;
}): boolean {
  const detection = normalizeSpaces(input.detectionQuestion);
  const evidence = normalizeSpaces(input.evidenceQuestion);
  if (!detection || !evidence) return false;
  if (isQuestionLike(detection)) return false;
  const wordCount = detection.split(/\s+/).filter(Boolean).length;
  const weakTail =
    wordCount <= 4 &&
    /^(?:and|or|then|also|plus|because|so|where|for|to|of|in|on|with|about)\b/i.test(
      detection,
    );
  return weakTail || (wordCount <= 3 && evidence.length > detection.length + 20);
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
  if (
    /\b(experience|background|current role|your role|responsibilit(?:y|ies)|company|project|tech stack)\b/i.test(
      question,
    )
  ) {
    return "behavioral";
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
  const displayQuestion =
    shouldUseEvidenceOverDetection({ detectionQuestion, evidenceQuestion })
      ? evidenceQuestion
      : detectionQuestion || evidenceQuestion || fallback;
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
  const reason = answerabilityReason({
    displayQuestion,
    intent,
    confidence,
    isFollowUp,
    hasAnchor: hasFollowupAnchor({
      detection,
      metadata: input.metadata,
      activeTopic: input.activeTopic,
    }),
    detectionIgnoredNoise: !!detection?.ignoredNoise,
  });

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
    shouldAnswer: !reason,
    reason,
  };
}
