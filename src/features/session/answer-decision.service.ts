import type { ReconstructedQuestion } from "./question-reconstructor.service";
import type { ActiveTopicMemory } from "./topic-memory.service";

export type AnswerDecisionReason =
  | "valid_new_question"
  | "valid_followup"
  | "low_confidence_noise"
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

export function decideAnswer(input: DecideAnswerInput): AnswerDecision {
  const question = input.reconstructedQuestion;
  if (!question.shouldAnswer || question.intent === "noise") {
    return {
      shouldAnswer: false,
      reason:
        question.reason === "missing_followup_target" ||
        question.reason === "unclear_transcript" ||
        question.reason === "low_confidence_noise"
          ? question.reason
          : "low_confidence_noise",
      questionForDisplay: question.displayQuestion,
      questionForLLM: question.llmQuestion,
    };
  }

  if (question.isFollowUp && !input.activeTopic && !input.selectedAnswerPresent && !question.followupTargetId) {
    return {
      shouldAnswer: false,
      reason: "missing_followup_target",
      questionForDisplay: question.displayQuestion,
      questionForLLM: question.llmQuestion,
    };
  }

  if (!question.displayQuestion.trim() || question.confidence < 0.25) {
    return {
      shouldAnswer: false,
      reason: "unclear_transcript",
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
