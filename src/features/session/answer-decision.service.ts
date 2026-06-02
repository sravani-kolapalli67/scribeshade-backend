import type { ReconstructedQuestion } from "./question-reconstructor.service";
import type { ActiveTopicMemory } from "./topic-memory.service";

export type AnswerDecisionReason =
  | "valid_new_question"
  | "valid_followup"
  | "low_confidence_noise"
  | "duplicate_question"
  | "missing_followup_target"
  | "unclear_transcript";

export type AnswerDecision = {
  shouldAnswer: boolean;
  reason: AnswerDecisionReason;
  questionForDisplay: string;
  questionForLLM: string;
};

type DecideAnswerInput = {
  reconstructedQuestion: ReconstructedQuestion;
  activeTopic: ActiveTopicMemory | null;
  selectedAnswerPresent: boolean;
};

function normalizeKey(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const left = new Set(normalizeKey(a).split(" ").filter(Boolean));
  const right = new Set(normalizeKey(b).split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.max(left.size, right.size);
}

export function decideAnswer(input: DecideAnswerInput): AnswerDecision {
  const question = input.reconstructedQuestion;

  if (!question.shouldAnswer || question.intent === "noise") {
    return {
      shouldAnswer: false,
      reason:
        question.confidence < 0.45 || question.intent === "noise"
          ? "low_confidence_noise"
          : "unclear_transcript",
      questionForDisplay: question.displayQuestion,
      questionForLLM: question.llmQuestion,
    };
  }

  if (
    !question.isFollowUp &&
    input.activeTopic?.lastQuestion &&
    tokenOverlap(question.displayQuestion, input.activeTopic.lastQuestion) >= 0.92
  ) {
    return {
      shouldAnswer: false,
      reason: "duplicate_question",
      questionForDisplay: question.displayQuestion,
      questionForLLM: question.llmQuestion,
    };
  }

  if (
    question.isFollowUp &&
    !input.activeTopic &&
    !input.selectedAnswerPresent &&
    !question.followupTargetId
  ) {
    return {
      shouldAnswer: false,
      reason: "missing_followup_target",
      questionForDisplay: question.displayQuestion,
      questionForLLM: question.llmQuestion,
    };
  }

  return {
    shouldAnswer: true,
    reason: question.isFollowUp ? "valid_followup" : "valid_new_question",
    questionForDisplay: question.displayQuestion,
    questionForLLM: question.llmQuestion,
  };
}
