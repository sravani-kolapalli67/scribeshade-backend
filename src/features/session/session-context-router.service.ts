import type { AIAnswerLiveContextMetadata } from "./ai-answer.dto";
import type {
  AnswerHistoryEntry,
} from "./answer-quality";
import {
  deriveTopicFromAnyText,
  extractCodeBlocksFromText,
} from "./answer-quality";
import type { LatestSuccessfulAnswer } from "./ai-answer-ledger.service";
import type { SanitizedLiveRequest, TranscriptEvidenceV3 } from "./ai-answer-context-guards";
import {
  classifyManualQueryType,
  getCodeIntentSuppressedReason,
  hasExplicitCodeRequest,
  isShortFollowupCommand,
  type ManualQueryType,
} from "./short-followup";

export type SessionRouterRequestType =
  | "new_question"
  | "followup"
  | "clarification"
  | "code_request"
  | "code_explanation"
  | "debugging"
  | "system_design"
  | "scenario"
  | "behavioral_scenario"
  | "resume_question"
  | "project_question"
  | "screen_analysis"
  | "partial_evolving"
  | "unknown";

export type SessionRouterBindingSource =
  | "selected_answer"
  | "latest_successful_answer"
  | "transcript_latest_question"
  | "manual_query"
  | "none";

export type MultiQuestionSegmentation =
  | "single_question"
  | "multiple_questions"
  | "follow_up"
  | "candidate_speech"
  | "interviewer_question";

export type SessionContextRouterDecision = {
  requestType: SessionRouterRequestType;
  targetQuestion: string;
  targetAnswerId: string | null;
  bindingSource: SessionRouterBindingSource;
  shouldUseResume: boolean;
  shouldUseProjects: boolean;
  shouldUsePreviousAnswer: boolean;
  shouldUseTranscriptWindow: boolean;
  shouldUseCodeMemory: boolean;
  topic: string;
  confidence: number;
  reason: string;
  manualQueryType: ManualQueryType;
  segmentation: MultiQuestionSegmentation;
  shortFollowupDetected: boolean;
  codeIntentDetected: boolean;
  codeIntentSuppressedReason: string | null;
  latestTranscriptQuestion: string;
  latestTranscriptQuestionTimestamp: number | null;
  oldQuestionMergeBlocked: boolean;
  boundTarget: AnswerHistoryEntry | null;
};

const TRANSCRIPT_FALLBACK_WINDOW_MS = 90_000;

function normalizeSpaces(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function isQuestionLike(text: string): boolean {
  return /[?]/.test(text) ||
    /^(what|why|how|when|where|which|who|can|could|would|should|is|are|do|does|did|explain|define|describe|tell me|write|implement|design)\b/i.test(text);
}

function latestTranscriptQuestion(input: TranscriptEvidenceV3 | undefined): {
  question: string;
  timestamp: number | null;
  speaker: "candidate" | "interviewer" | null;
} {
  const line = [...(input?.lines || [])]
    .reverse()
    .find((entry) => isQuestionLike(entry.text));
  if (!line) {
    return {
      question: normalizeSpaces(input?.currentQuestionHint || input?.compactQuery || ""),
      timestamp: null,
      speaker: null,
    };
  }
  return {
    question: normalizeSpaces(line.text),
    timestamp: typeof line.timestamp === "number" ? line.timestamp : null,
    speaker: line.speaker,
  };
}

function countQuestionLikeSegments(text: string): number {
  const matches = normalizeSpaces(text).match(/\?/g);
  if (matches && matches.length > 1) return matches.length;
  const starts = normalizeSpaces(text).match(/\b(what|why|how|when|where|which|who|can|could|would|should|is|are|do|does|did)\b/gi);
  return starts?.length || 0;
}

function isPartialEvolvingQuestion(text: string): boolean {
  const normalized = normalizeSpaces(text);
  if (!normalized) return true;
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return wordCount <= 9 && !isQuestionLike(normalized);
}

function buildTargetFromLatestAnswer(
  answer: LatestSuccessfulAnswer,
  orderIndex: number,
): AnswerHistoryEntry {
  return {
    id: answer.id,
    question: answer.question,
    answer: answer.answer,
    timestamp: answer.createdAt.getTime(),
    codeBlocks: answer.codeBlocks,
    topic: answer.topic,
    orderIndex,
  };
}

function buildTargetFromFrontendMetadata(
  metadata: AIAnswerLiveContextMetadata | undefined,
  orderIndex: number,
): AnswerHistoryEntry | null {
  const id = metadata?.latestAnswerId?.trim();
  const answer = metadata?.latestAnswerText?.trim();
  if (!id || !answer) return null;
  const question = metadata?.latestAnswerQuestion?.trim() || "";
  return {
    id,
    question,
    answer,
    timestamp: Date.now(),
    codeBlocks: extractCodeBlocksFromText(answer),
    topic:
      metadata?.latestAnswerTopic?.trim() ||
      deriveTopicFromAnyText(`${question} ${answer}`) ||
      "general",
    orderIndex,
  };
}

function buildTargetFromSelectedMetadata(
  metadata: AIAnswerLiveContextMetadata | undefined,
  orderIndex: number,
): AnswerHistoryEntry | null {
  const id = metadata?.selectedAnswerId?.trim();
  const answer = metadata?.selectedAnswerText?.trim();
  if (!id || !answer) return null;
  const question = metadata?.selectedAnswerQuestion?.trim() || "";
  return {
    id,
    question,
    answer,
    timestamp: Date.now(),
    codeBlocks: (metadata?.selectedAnswerCodeBlocks || []).filter(Boolean),
    topic:
      metadata?.selectedAnswerTopic?.trim() ||
      deriveTopicFromAnyText(`${question} ${answer}`) ||
      "general",
    orderIndex,
  };
}

function canUseTranscriptFallback(input: {
  latestTranscriptQuestionTimestamp: number | null;
  latestSuccessfulAnswer: LatestSuccessfulAnswer | null;
}): boolean {
  if (!input.latestTranscriptQuestionTimestamp) return !input.latestSuccessfulAnswer;
  if (!input.latestSuccessfulAnswer) return true;
  const answerTimestamp = input.latestSuccessfulAnswer.createdAt.getTime();
  return (
    input.latestTranscriptQuestionTimestamp > answerTimestamp ||
    Math.abs(input.latestTranscriptQuestionTimestamp - answerTimestamp) <= TRANSCRIPT_FALLBACK_WINDOW_MS
  );
}

export function routeAIAnswerSessionContext(input: {
  rawInput: string;
  normalizedInput: string;
  isCustomQuery: boolean;
  metadata?: AIAnswerLiveContextMetadata;
  sanitizedRequest?: SanitizedLiveRequest;
  transcriptEvidence?: TranscriptEvidenceV3;
  history: AnswerHistoryEntry[];
  latestSuccessfulAnswer: LatestSuccessfulAnswer | null;
}): SessionContextRouterDecision {
  const normalizedInput = normalizeSpaces(input.normalizedInput || input.rawInput);
  const transcriptQuestion = latestTranscriptQuestion(input.transcriptEvidence);
  const manualQueryType =
    input.metadata?.manualQueryType ||
    (input.isCustomQuery ? classifyManualQueryType(normalizedInput) : "unknown");
  const shortFollowupDetected =
    isShortFollowupCommand(normalizedInput) ||
    manualQueryType === "short_followup";
  const codeIntentSuppressedReason = getCodeIntentSuppressedReason(normalizedInput);
  const codeIntentDetected =
    !codeIntentSuppressedReason && hasExplicitCodeRequest(normalizedInput);
  const lower = normalizedInput.toLowerCase();
  const selectedAnswerId = input.metadata?.selectedAnswerId?.trim();
  const selectedTarget = selectedAnswerId
    ? input.history.find((entry) => entry.id === selectedAnswerId) ||
      buildTargetFromSelectedMetadata(input.metadata, input.history.length)
    : null;
  const latestTarget = input.latestSuccessfulAnswer
    ? buildTargetFromLatestAnswer(input.latestSuccessfulAnswer, input.history.length)
    : buildTargetFromFrontendMetadata(input.metadata, input.history.length);
  const latestTargetSource = input.latestSuccessfulAnswer
    ? input.latestSuccessfulAnswer.source
    : latestTarget
      ? "frontend_metadata"
      : null;
  const transcriptFallbackAllowed = canUseTranscriptFallback({
    latestTranscriptQuestionTimestamp: transcriptQuestion.timestamp,
    latestSuccessfulAnswer: input.latestSuccessfulAnswer,
  });
  const segmentation: MultiQuestionSegmentation = shortFollowupDetected
    ? "follow_up"
    : transcriptQuestion.speaker === "candidate"
      ? "candidate_speech"
      : transcriptQuestion.speaker === "interviewer"
        ? "interviewer_question"
        : countQuestionLikeSegments(normalizedInput) > 1
          ? "multiple_questions"
          : "single_question";

  let requestType: SessionRouterRequestType = "new_question";
  if (shortFollowupDetected || selectedAnswerId || input.sanitizedRequest?.answerKind === "followup") {
    requestType = "followup";
  } else if (codeIntentDetected) {
    requestType = "code_request";
  } else if (/\b(debug|fix|bug|error|issue|failing|not working)\b/i.test(normalizedInput)) {
    requestType = "debugging";
  } else if (/\b(this code|that code|previous code|the code|this query|that query|previous query|explain.*(?:code|query|function|snippet))\b/i.test(normalizedInput)) {
    requestType = "code_explanation";
  } else if (/\b(projects?|project work|things you built|worked on)\b/i.test(normalizedInput)) {
    requestType = "project_question";
  } else if (/\b(resume|profile|experience|skill set|education|background)\b/i.test(normalizedInput)) {
    requestType = "resume_question";
  } else if (/\b(system design|design a|architect|architecture|scalab|throughput|latency|distributed|microservice)\b/i.test(normalizedInput)) {
    requestType = "system_design";
  } else if (input.transcriptEvidence?.scenarioDetected || /\b(scenario|suppose|imagine|production|outage)\b/i.test(normalizedInput)) {
    requestType = "scenario";
  } else if (/\b(behavioral|stakeholder|conflict|challenge|critical situation|how did you handle)\b/i.test(normalizedInput)) {
    requestType = "behavioral_scenario";
  } else if (/\b(screen|screenshot|visible code|on the screen)\b/i.test(normalizedInput)) {
    requestType = "screen_analysis";
  } else if (isPartialEvolvingQuestion(normalizedInput)) {
    requestType = "partial_evolving";
  } else if (!normalizedInput) {
    requestType = "unknown";
  }

  let bindingSource: SessionRouterBindingSource = input.isCustomQuery ? "manual_query" : "none";
  let targetAnswerId: string | null = null;
  let boundTarget: AnswerHistoryEntry | null = null;
  let reason = "deterministic_new_question";
  let targetQuestion = normalizedInput;
  let confidence = 0.72;

  if (requestType === "followup") {
    if (selectedTarget) {
      bindingSource = "selected_answer";
      targetAnswerId = selectedTarget.id;
      boundTarget = selectedTarget;
      reason = "selected_answer_bound";
      confidence = 0.95;
    } else if (latestTarget) {
      bindingSource = "latest_successful_answer";
      targetAnswerId = latestTarget.id;
      boundTarget = latestTarget;
      reason = latestTargetSource === "db_ledger"
        ? "latest_saved_ledger_answer_bound"
        : "frontend_latest_answer_race_fallback_bound";
      confidence = latestTargetSource === "db_ledger" ? 0.9 : 0.68;
    } else if (transcriptQuestion.question && transcriptFallbackAllowed) {
      bindingSource = "transcript_latest_question";
      targetQuestion = shortFollowupDetected ? normalizedInput : transcriptQuestion.question;
      reason = "latest_transcript_question_fallback_bound";
      confidence = 0.55;
    } else {
      bindingSource = "none";
      reason = "short_followup_without_safe_binding";
      confidence = 0.2;
    }
  }

  const topic =
    boundTarget?.topic ||
    deriveTopicFromAnyText(`${targetQuestion} ${boundTarget?.answer || ""}`) ||
    "general";
  const shouldUseProjects =
    requestType === "project_question" ||
    /\b(projects?|project work|things you built|worked on)\b/i.test(lower);
  const shouldUseResume =
    requestType === "resume_question" ||
    shouldUseProjects ||
    /\b(resume|profile|experience|skill set|education|background)\b/i.test(lower);

  return {
    requestType,
    targetQuestion,
    targetAnswerId,
    bindingSource,
    shouldUseResume,
    shouldUseProjects,
    shouldUsePreviousAnswer: Boolean(boundTarget),
    shouldUseTranscriptWindow: requestType !== "followup" || bindingSource === "transcript_latest_question",
    shouldUseCodeMemory: codeIntentDetected || Boolean(boundTarget?.codeBlocks.length),
    topic,
    confidence,
    reason,
    manualQueryType,
    segmentation,
    shortFollowupDetected,
    codeIntentDetected,
    codeIntentSuppressedReason,
    latestTranscriptQuestion: transcriptQuestion.question,
    latestTranscriptQuestionTimestamp: transcriptQuestion.timestamp,
    oldQuestionMergeBlocked: requestType === "followup",
    boundTarget,
  };
}
