import type { AIAnswerLiveContextMetadata } from "../ai-answer.dto";
import type { TranscriptEvidenceV3 } from "../ai-answer-context-guards";
import type {
  AnswerKind,
  AnswerTrust,
  InterviewerTone,
  LiveRequestKind,
  SanitizedLiveRequest,
} from "../session-intelligence.types";
import {
  getCodeIntentSuppressedReason,
  hasExplicitCodeRequest,
  isShortFollowupCommand,
} from "../short-followup";

const CODE_FOLLOWUP_RE =
  /\b(this code|the code|previous code|code you wrote|that code|this function|that function|the query|that query|same query|same code|explain (?:it|this|that)|optimi[sz]e|debug|edge cases?|test it|lag|row_number|window function)\b/i;
const PROJECT_RE =
  /\b(projects?|experience|profile|background|skill set|worked on|built|role|responsibilit(?:y|ies)|tech stack)\b/i;
const FILLER_RE =
  /^(hi|hello|hey|okay|ok|yeah|yes|no|right|fine|hmm|um|uh|thanks|thank you|can you hear me|am i audible)$/i;
const CHALLENGE_RE =
  /\b(are you sure|is that correct|not correct|why did you|why would you|why this|why that|justify|defend|how come|explain your reasoning)\b/i;
const PROVISIONAL_RE =
  /\b(let me explain|the setup is|suppose|assume|imagine|first|before that)\b/i;
const TOPIC_CONTINUATION_RE =
  /^(?:(?:and|yeah)[\s,.]+){0,2}what about [a-z0-9 .+#/_-]{2,50}(?: then)?\??$/i;
const FRESH_CODE_GENERATION_RE =
  /\b(write|implement|create|build|develop|show|give|provide)\b.{0,80}\b(code|snippet|component|hook|function|class|query|api|algorithm|program)\b/i;
const FRAMEWORK_CODE_RE =
  /\b(?:code\s+in\s+(?:react|vue|angular|node(?:\.js)?|python|javascript|typescript|java|sql|pyspark)|(?:react|vue|angular|node(?:\.js)?|python|javascript|typescript|java|sql|pyspark)\s+(?:code|component|hook|function|snippet|query))\b/i;
const REACT_CODE_CONCEPT_RE =
  /(?=.*\b(write|implement|create|build|code|component|snippet|program)\b)(?=.*\b(useeffect|usecontext|context api|react context)\b)/i;
const URGENCY_RE =
  /\b(quickly|fast|immediately|right now|urgent|asap|within \d+\s*(?:minutes?|hours?|seconds?))\b/i;
const SKEPTICAL_RE =
  /\b(are you sure|is that correct|i think|not correct|how come|really|are you certain)\b/i;
const CLARIFICATION_RE =
  /\b(can you explain|clarify|explain more|tell me more|what do you mean|elaborate)\b/i;
const STRESS_TEST_RE =
  /\b(what if|fails?|failure|production|outage|high traffic|scale|bottleneck|rollback|monitoring)\b/i;
const DEEP_DIVE_RE =
  /\b(go deeper|deep dive|walk me through|step by step|architecture|internals|how exactly)\b/i;

export type SanitizerDiagnostics = {
  originalMode: string | null;
  effectiveMode: string;
  requestKind: LiveRequestKind;
  answerKind: AnswerKind;
  answerTrust: AnswerTrust;
  selectedCleared: boolean;
  previousAnswerCleared: boolean;
  codeIntentDetected: boolean;
  scenarioDetected: boolean;
  challengeDetected: boolean;
  clearReason: string | null;
};

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isCodeGenerationRequest(text: string): boolean {
  if (getCodeIntentSuppressedReason(text)) return false;
  return (
    hasExplicitCodeRequest(text) ||
    FRESH_CODE_GENERATION_RE.test(text) ||
    FRAMEWORK_CODE_RE.test(text) ||
    REACT_CODE_CONCEPT_RE.test(text)
  );
}

function inferInterviewerTone(input: {
  text: string;
  scenarioDetected: boolean;
}): InterviewerTone {
  if (input.scenarioDetected && STRESS_TEST_RE.test(input.text)) {
    return "stress_test";
  }
  if (URGENCY_RE.test(input.text)) return "urgency";
  if (SKEPTICAL_RE.test(input.text)) return "skeptical";
  if (STRESS_TEST_RE.test(input.text)) return "stress_test";
  if (CHALLENGE_RE.test(input.text)) return "challenge";
  if (CLARIFICATION_RE.test(input.text)) return "clarification";
  if (DEEP_DIVE_RE.test(input.text)) return "deep_dive";
  return "neutral";
}

function emptyMetadata(): AIAnswerLiveContextMetadata {
  return { answerClickMode: "answer_latest_unanswered" };
}

function hasSelectedContext(metadata: AIAnswerLiveContextMetadata): boolean {
  return Boolean(
    metadata.selectedAnswerId ||
      metadata.selectedAnswerQuestion ||
      metadata.selectedAnswerText ||
      metadata.selectedAnswerCodeBlocks?.length ||
      metadata.selectedAnswerTopic,
  );
}

function hasPreviousContext(metadata: AIAnswerLiveContextMetadata): boolean {
  return Boolean(
    metadata.previousAiAnswer ||
      metadata.previousAiAnswers?.length ||
      metadata.previousCodeBlocks?.length,
  );
}

function clearSelectedContext(
  metadata: AIAnswerLiveContextMetadata,
): AIAnswerLiveContextMetadata {
  return {
    ...metadata,
    selectedAnswerId: undefined,
    selectedAnswerQuestion: undefined,
    selectedAnswerText: undefined,
    selectedAnswerCodeBlocks: undefined,
    selectedAnswerTopic: undefined,
    selectedAnswerIntentId: undefined,
  };
}

function clearPreviousContext(
  metadata: AIAnswerLiveContextMetadata,
): AIAnswerLiveContextMetadata {
  return {
    ...metadata,
    previousAiAnswer: undefined,
    previousAiAnswers: undefined,
    previousCodeBlocks: undefined,
  };
}

function authorizeMetadata(input: {
  metadata: AIAnswerLiveContextMetadata;
  allowSelectedAnswer: boolean;
  allowPreviousAnswer: boolean;
  allowPreviousAnswers: boolean;
  allowCodeMemory: boolean;
  effectiveMode: AIAnswerLiveContextMetadata["answerClickMode"];
}): AIAnswerLiveContextMetadata {
  const selected = input.allowSelectedAnswer
    ? { ...input.metadata }
    : clearSelectedContext(input.metadata);
  const previous = input.allowPreviousAnswer || input.allowPreviousAnswers
    ? selected
    : clearPreviousContext(selected);

  return {
    ...previous,
    answerClickMode: input.effectiveMode,
    previousAiAnswer: input.allowPreviousAnswer
      ? previous.previousAiAnswer
      : undefined,
    previousAiAnswers: input.allowPreviousAnswers
      ? previous.previousAiAnswers?.map((entry) => ({
          ...(entry.question ? { question: entry.question } : {}),
          answer: entry.answer,
          ...(input.allowCodeMemory && entry.codeBlocks?.length
            ? { codeBlocks: entry.codeBlocks }
            : {}),
        }))
      : undefined,
    previousCodeBlocks: input.allowCodeMemory
      ? previous.previousCodeBlocks
      : undefined,
  };
}

function buildResult(input: {
  kind: LiveRequestKind;
  metadata: AIAnswerLiveContextMetadata;
  latestQuestionHint: string;
  clearReason?: string;
  allowSelectedAnswer: boolean;
  allowPreviousAnswer: boolean;
  allowPreviousAnswers: boolean;
  allowCodeMemory: boolean;
  allowProjectContext: boolean;
  allowHistory: boolean;
  answerKind: AnswerKind;
  answerTrust: AnswerTrust;
  transcriptEvidence?: TranscriptEvidenceV3;
  interviewerTone: SanitizedLiveRequest["interviewerTone"];
  effectiveMode: AIAnswerLiveContextMetadata["answerClickMode"];
}): SanitizedLiveRequest {
  return {
    kind: input.kind,
    effectiveAnswerClickMode:
      input.effectiveMode || "answer_latest_unanswered",
    metadata: authorizeMetadata({
      metadata: input.metadata,
      allowSelectedAnswer: input.allowSelectedAnswer,
      allowPreviousAnswer: input.allowPreviousAnswer,
      allowPreviousAnswers: input.allowPreviousAnswers,
      allowCodeMemory: input.allowCodeMemory,
      effectiveMode: input.effectiveMode,
    }),
    ...(input.latestQuestionHint
      ? { latestQuestionHint: input.latestQuestionHint }
      : {}),
    ...(input.clearReason ? { clearReason: input.clearReason } : {}),
    allowSelectedAnswer: input.allowSelectedAnswer,
    allowPreviousAnswer: input.allowPreviousAnswer,
    allowPreviousAnswers: input.allowPreviousAnswers,
    allowCodeMemory: input.allowCodeMemory,
    allowProjectContext: input.allowProjectContext,
    allowHistory: input.allowHistory,
    answerKind: input.answerKind,
    answerTrust: input.answerTrust,
    interviewerTone: input.interviewerTone,
    scenarioDetected: input.transcriptEvidence?.scenarioDetected === true,
    ...(input.transcriptEvidence?.scenarioPacket
      ? { scenarioPacket: input.transcriptEvidence.scenarioPacket }
      : {}),
  };
}

export function sanitizeLiveRequestContextV4(input: {
  metadata?: AIAnswerLiveContextMetadata;
  transcriptEvidence?: TranscriptEvidenceV3;
  isRegenerate: boolean;
}): SanitizedLiveRequest {
  const metadata = input.metadata || emptyMetadata();
  const latestQuestionHint = normalizeSpaces(
    input.transcriptEvidence?.scenarioQuestion ||
      input.transcriptEvidence?.currentQuestionHint ||
      metadata.currentQuestionForBackend ||
      metadata.activeQuestionDetection?.cleanedQuestion ||
      input.transcriptEvidence?.compactQuery ||
      "",
  );
  const evidenceText = normalizeSpaces(
    [
      input.transcriptEvidence?.compactQuery || "",
      input.transcriptEvidence?.text || "",
      latestQuestionHint,
    ].join(" "),
  );
  const classificationText =
    latestQuestionHint ||
    normalizeSpaces(input.transcriptEvidence?.compactQuery || "") ||
    evidenceText;
  const scenarioDetected = input.transcriptEvidence?.scenarioDetected === true;
  const codeGeneration = isCodeGenerationRequest(classificationText);
  const shortFollowupDetected = isShortFollowupCommand(classificationText);
  const codeFollowup = CODE_FOLLOWUP_RE.test(classificationText);
  const challengeDetected = CHALLENGE_RE.test(classificationText);
  const projectQuestion = PROJECT_RE.test(classificationText);
  const noiseSources = [
    input.transcriptEvidence?.compactQuery || "",
    input.transcriptEvidence?.text || "",
    latestQuestionHint,
  ]
    .map(normalizeSpaces)
    .filter(Boolean);
  const noise =
    !scenarioDetected &&
    (noiseSources.length === 0 ||
      noiseSources.every((source) => FILLER_RE.test(source)));
  const explicitSelectedFollowup =
    metadata.answerClickMode === "answer_followup" &&
    Boolean(metadata.selectedAnswerId?.trim());
  const trueFollowup =
    metadata.activeQuestionDetection?.isFollowUp === true ||
    TOPIC_CONTINUATION_RE.test(latestQuestionHint) ||
    shortFollowupDetected ||
    metadata.manualQueryType === "short_followup";
  const interviewerTone = inferInterviewerTone({
    text: classificationText,
    scenarioDetected,
  });
  const selectedPresent = hasSelectedContext(metadata);
  const previousPresent = hasPreviousContext(metadata);

  if (input.isRegenerate) {
    return buildResult({
      kind: "regenerate",
      metadata,
      latestQuestionHint,
      allowSelectedAnswer: true,
      allowPreviousAnswer: true,
      allowPreviousAnswers: true,
      allowCodeMemory: true,
      allowProjectContext: true,
      allowHistory: false,
      answerKind: "regenerate",
      answerTrust: "strong",
      transcriptEvidence: input.transcriptEvidence,
      interviewerTone,
      effectiveMode: "regenerate_answer",
    });
  }

  if (codeGeneration && !explicitSelectedFollowup) {
    return buildResult({
      kind: "code_generation",
      metadata,
      latestQuestionHint,
      ...(selectedPresent || previousPresent
        ? { clearReason: "fresh_code_generation_context_cleared" }
        : {}),
      allowSelectedAnswer: false,
      allowPreviousAnswer: false,
      allowPreviousAnswers: false,
      allowCodeMemory: false,
      allowProjectContext: false,
      allowHistory: false,
      answerKind: "final",
      answerTrust: "strong",
      transcriptEvidence: input.transcriptEvidence,
      interviewerTone,
      effectiveMode: "answer_latest_unanswered",
    });
  }

  if (scenarioDetected) {
    return buildResult({
      kind: "scenario",
      metadata,
      latestQuestionHint,
      ...(selectedPresent || previousPresent
        ? { clearReason: "scenario_topic_conflict" }
        : {}),
      allowSelectedAnswer: false,
      allowPreviousAnswer: false,
      allowPreviousAnswers: false,
      allowCodeMemory: false,
      allowProjectContext: true,
      allowHistory: false,
      answerKind: "final",
      answerTrust: "strong",
      transcriptEvidence: input.transcriptEvidence,
      interviewerTone,
      effectiveMode: "answer_latest_unanswered",
    });
  }

  if (challengeDetected) {
    return buildResult({
      kind: "challenge_or_correction",
      metadata,
      latestQuestionHint,
      ...(selectedPresent
        ? { clearReason: "challenge_selected_context_cleared" }
        : {}),
      allowSelectedAnswer: false,
      allowPreviousAnswer: true,
      allowPreviousAnswers: true,
      allowCodeMemory: codeFollowup,
      allowProjectContext: projectQuestion,
      allowHistory: true,
      answerKind: "correction",
      answerTrust: "strong",
      transcriptEvidence: input.transcriptEvidence,
      interviewerTone,
      effectiveMode: "answer_latest_unanswered",
    });
  }

  if (explicitSelectedFollowup) {
    return buildResult({
      kind: codeFollowup ? "code_followup" : "selected_card_followup",
      metadata,
      latestQuestionHint,
      allowSelectedAnswer: true,
      allowPreviousAnswer: true,
      allowPreviousAnswers: false,
      allowCodeMemory:
        codeFollowup || Boolean(metadata.selectedAnswerCodeBlocks?.length),
      allowProjectContext: projectQuestion,
      allowHistory: true,
      answerKind: "followup",
      answerTrust: "strong",
      transcriptEvidence: input.transcriptEvidence,
      interviewerTone,
      effectiveMode: "answer_followup",
    });
  }

  if (codeFollowup || trueFollowup) {
    return buildResult({
      kind: codeFollowup ? "code_followup" : "true_followup",
      metadata,
      latestQuestionHint,
      ...(selectedPresent
        ? { clearReason: "true_followup_selected_context_cleared" }
        : {}),
      allowSelectedAnswer: false,
      allowPreviousAnswer: true,
      allowPreviousAnswers: true,
      allowCodeMemory: codeFollowup,
      allowProjectContext: projectQuestion,
      allowHistory: true,
      answerKind: "followup",
      answerTrust: "strong",
      transcriptEvidence: input.transcriptEvidence,
      interviewerTone,
      effectiveMode: "answer_latest_unanswered",
    });
  }

  if (noise) {
    return buildResult({
      kind: "noise",
      metadata,
      latestQuestionHint,
      clearReason: "noise_only",
      allowSelectedAnswer: false,
      allowPreviousAnswer: false,
      allowPreviousAnswers: false,
      allowCodeMemory: false,
      allowProjectContext: false,
      allowHistory: false,
      answerKind: "provisional",
      answerTrust: "none",
      transcriptEvidence: input.transcriptEvidence,
      interviewerTone,
      effectiveMode: "answer_latest_unanswered",
    });
  }

  if (
    PROVISIONAL_RE.test(classificationText) &&
    !/[?]/.test(classificationText)
  ) {
    return buildResult({
      kind: "provisional_guidance",
      metadata,
      latestQuestionHint,
      clearReason: "setup_without_final_question",
      allowSelectedAnswer: false,
      allowPreviousAnswer: false,
      allowPreviousAnswers: false,
      allowCodeMemory: false,
      allowProjectContext: projectQuestion,
      allowHistory: false,
      answerKind: "provisional",
      answerTrust: "weak",
      transcriptEvidence: input.transcriptEvidence,
      interviewerTone,
      effectiveMode: "answer_latest_unanswered",
    });
  }

  return buildResult({
    kind: projectQuestion ? "project_question" : "latest_question",
    metadata,
    latestQuestionHint,
    ...(selectedPresent || previousPresent
      ? { clearReason: "latest_question_context_cleared" }
      : {}),
    allowSelectedAnswer: false,
    allowPreviousAnswer: false,
    allowPreviousAnswers: false,
    allowCodeMemory: false,
    allowProjectContext: projectQuestion,
    allowHistory: false,
    answerKind: "final",
    answerTrust: "strong",
    transcriptEvidence: input.transcriptEvidence,
    interviewerTone,
    effectiveMode: "answer_latest_unanswered",
  });
}

export function buildSanitizerDiagnostics(input: {
  originalMetadata?: AIAnswerLiveContextMetadata;
  sanitizedRequest: SanitizedLiveRequest;
}): SanitizerDiagnostics {
  const original = input.originalMetadata || emptyMetadata();
  return {
    originalMode: original.answerClickMode || null,
    effectiveMode: input.sanitizedRequest.effectiveAnswerClickMode,
    requestKind: input.sanitizedRequest.kind,
    answerKind: input.sanitizedRequest.answerKind,
    answerTrust: input.sanitizedRequest.answerTrust,
    selectedCleared:
      hasSelectedContext(original) &&
      !hasSelectedContext(input.sanitizedRequest.metadata),
    previousAnswerCleared:
      hasPreviousContext(original) &&
      !hasPreviousContext(input.sanitizedRequest.metadata),
    codeIntentDetected:
      input.sanitizedRequest.kind === "code_generation" ||
      input.sanitizedRequest.kind === "code_followup",
    scenarioDetected: input.sanitizedRequest.scenarioDetected,
    challengeDetected:
      input.sanitizedRequest.kind === "challenge_or_correction",
    clearReason: input.sanitizedRequest.clearReason || null,
  };
}
