import { z } from "zod";
import type { AnswerClickMode } from "./question-composer.service";
import type { QuestionQualityResult } from "./question-quality.service";

export const AI_ANSWER_LIMITS = {
  recentTranscriptWindowMax: 60,
  previousAiAnswerMaxChars: 1000,
  previousAiAnswersMax: 2,
  previousAiAnswerQuestionMaxChars: 500,
  previousCodeBlocksMax: 2,
  previousCodeBlockMaxChars: 1500,
  selectedAnswerQuestionMaxChars: 500,
  selectedAnswerTextMaxChars: 1000,
  selectedAnswerTopicMaxChars: 80,
} as const;

const speakerTypeSchema = z.enum([
  "interviewer",
  "candidate",
  "assistant",
  "system",
]);

const answerModeSchema = z.enum([
  "auto",
  "theory_only",
  "minimal_code",
  "code_required",
  "explain_existing_code",
  "system_design",
]);

const sourcePlatformSchema = z.enum(["web", "tauri"]);

const answerClickModeSchema = z.enum([
  "answer_latest_unanswered",
  "answer_selected_intent",
  "reanswer_previous",
  "regenerate_answer",
  "answer_followup",
]);

const speakerEntrySchema = z.object({
  speakerType: speakerTypeSchema,
  content: z.string().trim().min(1),
  timestamp: z.number().optional(),
});
const previousAiAnswerEntrySchema = z.object({
  question: z
    .string()
    .trim()
    .max(AI_ANSWER_LIMITS.previousAiAnswerQuestionMaxChars)
    .optional(),
  answer: z
    .string()
    .trim()
    .min(1)
    .max(AI_ANSWER_LIMITS.previousAiAnswerMaxChars),
  codeBlocks: z
    .array(z.string().max(AI_ANSWER_LIMITS.previousCodeBlockMaxChars))
    .max(AI_ANSWER_LIMITS.previousCodeBlocksMax)
    .optional(),
});

const activeQuestionDetectionSchema = z.object({
  activeQuestion: z.string().trim().min(1).max(2000),
  cleanedQuestion: z.string().trim().min(1).max(2000),
  isFollowUp: z.boolean(),
  topicChanged: z.boolean(),
  confidenceScore: z.number().min(0).max(1),
  ignoredNoise: z.boolean(),
  referencedHistoryTurnId: z.string().trim().min(1).max(120).optional(),
});

const SYNTHETIC_CONTINUITY_SUFFIX_RE = /\s+\(in context of:\s*[^()]+\)\s*$/i;

function normalizeManualQuestion(question: string): string {
  return question.replace(SYNTHETIC_CONTINUITY_SUFFIX_RE, "").trim();
}

export const aiAnswerRequestSchema = z.object({
  transcript: z.string().trim().min(1).optional(),
  requestId: z.string().trim().min(1).max(120).optional(),
  sessionId: z.string().trim().min(1).max(120).optional(),
  currentQuestion: z.string().trim().optional(),
  patchedTranscript: z.string().trim().optional(),
  recentTranscriptWindow: z
    .array(z.string().trim().min(1))
    .max(AI_ANSWER_LIMITS.recentTranscriptWindowMax)
    .optional(),
  speakerSeparatedTranscript: z
    .array(speakerEntrySchema)
    .max(AI_ANSWER_LIMITS.recentTranscriptWindowMax)
    .optional(),
  previousAiAnswer: z
    .string()
    .max(AI_ANSWER_LIMITS.previousAiAnswerMaxChars)
    .optional(),
  previousAiAnswers: z
    .array(previousAiAnswerEntrySchema)
    .max(AI_ANSWER_LIMITS.previousAiAnswersMax)
    .optional(),
  previousCodeBlocks: z
    .array(z.string().max(AI_ANSWER_LIMITS.previousCodeBlockMaxChars))
    .max(AI_ANSWER_LIMITS.previousCodeBlocksMax)
    .optional(),
  selectedAnswerId: z.string().trim().min(1).max(120).optional(),
  selectedAnswerQuestion: z
    .string()
    .max(AI_ANSWER_LIMITS.selectedAnswerQuestionMaxChars)
    .optional(),
  selectedAnswerText: z
    .string()
    .max(AI_ANSWER_LIMITS.selectedAnswerTextMaxChars)
    .optional(),
  selectedAnswerCodeBlocks: z
    .array(z.string().max(AI_ANSWER_LIMITS.previousCodeBlockMaxChars))
    .max(AI_ANSWER_LIMITS.previousCodeBlocksMax)
    .optional(),
  selectedAnswerTopic: z
    .string()
    .max(AI_ANSWER_LIMITS.selectedAnswerTopicMaxChars)
    .optional(),
  selectedIntentId: z.string().trim().min(1).max(120).optional(),
  selectedAnswerIntentId: z.string().trim().min(1).max(120).optional(),
  answerClickMode: answerClickModeSchema.optional(),
  answerMode: answerModeSchema.optional(),
  sourcePlatform: sourcePlatformSchema.optional(),
  isCustomQuery: z.boolean().optional(),
  isRegenerate: z.boolean().optional(),
  regenerate: z.boolean().optional(),
  regenerateTargetAnswerId: z.string().trim().min(1).max(120).optional(),
  regenerateInstruction: z.string().trim().min(1).max(500).optional(),
  activeQuestionDetection: activeQuestionDetectionSchema.optional(),
});

export type AIAnswerRequestDTO = z.infer<typeof aiAnswerRequestSchema>;

export type AIAnswerLiveContextMetadata = Omit<
  AIAnswerRequestDTO,
  "transcript" | "currentQuestion" | "patchedTranscript"
> & {
  rawTranscriptForBackend?: string;
  currentQuestionForBackend?: string;
  backendQuestionQuality?: QuestionQualityResult;
  backendQuestionCorrections?: string[];
  frontendConfidenceDowngraded?: boolean;
};

export interface NormalizedAIAnswerRequest {
  resolvedQuestion: string;
  resolvedFrom?:
    | "patchedTranscript"
    | "currentQuestion"
    | "transcript"
    | "none";
  liveContextMetadata?: AIAnswerLiveContextMetadata;
}

export function normalizeAIAnswerRequestBody(
  body: any,
): NormalizedAIAnswerRequest {
  if (!body || typeof body !== "object") {
    return { resolvedQuestion: "", resolvedFrom: "none" };
  }

  // Keep a defensive cap path in backend too.
  const clipped = {
    ...body,
    previousAiAnswer:
      typeof body.previousAiAnswer === "string"
        ? body.previousAiAnswer.slice(0, AI_ANSWER_LIMITS.previousAiAnswerMaxChars)
        : body.previousAiAnswer,
    previousAiAnswers: Array.isArray(body.previousAiAnswers)
      ? body.previousAiAnswers
          .slice(-AI_ANSWER_LIMITS.previousAiAnswersMax)
          .map((entry: any) => ({
            ...(typeof entry?.question === "string"
              ? {
                  question: entry.question.slice(
                    0,
                    AI_ANSWER_LIMITS.previousAiAnswerQuestionMaxChars,
                  ),
                }
              : {}),
            answer:
              typeof entry?.answer === "string"
                ? entry.answer.slice(0, AI_ANSWER_LIMITS.previousAiAnswerMaxChars)
                : entry?.answer,
            ...(Array.isArray(entry?.codeBlocks)
              ? {
                  codeBlocks: entry.codeBlocks
                    .slice(0, AI_ANSWER_LIMITS.previousCodeBlocksMax)
                    .map((b: any) =>
                      typeof b === "string"
                        ? b.slice(0, AI_ANSWER_LIMITS.previousCodeBlockMaxChars)
                        : b,
                    ),
                }
              : {}),
          }))
      : body.previousAiAnswers,
    previousCodeBlocks: Array.isArray(body.previousCodeBlocks)
      ? body.previousCodeBlocks
          .slice(0, AI_ANSWER_LIMITS.previousCodeBlocksMax)
          .map((b: any) =>
            typeof b === "string"
              ? b.slice(0, AI_ANSWER_LIMITS.previousCodeBlockMaxChars)
              : b,
          )
      : body.previousCodeBlocks,
    selectedAnswerQuestion:
      typeof body.selectedAnswerQuestion === "string"
        ? body.selectedAnswerQuestion.slice(0, AI_ANSWER_LIMITS.selectedAnswerQuestionMaxChars)
        : body.selectedAnswerQuestion,
    selectedAnswerText:
      typeof body.selectedAnswerText === "string"
        ? body.selectedAnswerText.slice(0, AI_ANSWER_LIMITS.selectedAnswerTextMaxChars)
        : body.selectedAnswerText,
    selectedAnswerTopic:
      typeof body.selectedAnswerTopic === "string"
        ? body.selectedAnswerTopic.slice(0, AI_ANSWER_LIMITS.selectedAnswerTopicMaxChars)
        : body.selectedAnswerTopic,
    selectedAnswerCodeBlocks: Array.isArray(body.selectedAnswerCodeBlocks)
      ? body.selectedAnswerCodeBlocks
          .slice(0, AI_ANSWER_LIMITS.previousCodeBlocksMax)
          .map((b: any) =>
            typeof b === "string"
              ? b.slice(0, AI_ANSWER_LIMITS.previousCodeBlockMaxChars)
              : b,
          )
      : body.selectedAnswerCodeBlocks,
    recentTranscriptWindow: Array.isArray(body.recentTranscriptWindow)
      ? body.recentTranscriptWindow.slice(-AI_ANSWER_LIMITS.recentTranscriptWindowMax)
      : body.recentTranscriptWindow,
    speakerSeparatedTranscript: Array.isArray(body.speakerSeparatedTranscript)
      ? body.speakerSeparatedTranscript.slice(-AI_ANSWER_LIMITS.recentTranscriptWindowMax)
      : body.speakerSeparatedTranscript,
  };

  const parsed = aiAnswerRequestSchema.safeParse(clipped);
  if (!parsed.success) {
    return { resolvedQuestion: "", resolvedFrom: "none" };
  }

  const dto = parsed.data;
  const patchedTranscript = dto.patchedTranscript?.trim() || "";
  const currentQuestion = dto.currentQuestion?.trim() || "";
  const transcriptText = dto.transcript?.trim() || "";
  const manualQuestion = normalizeManualQuestion(currentQuestion || transcriptText);
  const resolvedQuestion =
    patchedTranscript ||
    (!!dto.isCustomQuery ? manualQuestion : "") ||
    transcriptText ||
    currentQuestion;
  const resolvedFrom: NormalizedAIAnswerRequest["resolvedFrom"] =
    patchedTranscript
      ? "patchedTranscript"
      : !!dto.isCustomQuery && currentQuestion
        ? "currentQuestion"
        : transcriptText
          ? "transcript"
          : currentQuestion
            ? "currentQuestion"
            : "none";

  const {
    transcript: rawTranscript,
    currentQuestion: currentQuestionHint,
    patchedTranscript: _patchedTranscript,
    ...liveContextMetadata
  } = dto;
  const enrichedLiveContextMetadata: AIAnswerLiveContextMetadata = {
    ...liveContextMetadata,
    rawTranscriptForBackend: rawTranscript,
    currentQuestionForBackend: currentQuestionHint,
  };
  return {
    resolvedQuestion,
    resolvedFrom,
    liveContextMetadata:
      Object.keys(enrichedLiveContextMetadata).length > 0
        ? enrichedLiveContextMetadata
        : undefined,
  };
}

export function resolveAnswerClickMode(input: {
  metadata?: AIAnswerLiveContextMetadata;
  isRegenerate: boolean;
}): AnswerClickMode {
  if (input.metadata?.answerClickMode) return input.metadata.answerClickMode;
  if (input.isRegenerate) return "regenerate_answer";
  if (input.metadata?.selectedIntentId || input.metadata?.selectedAnswerIntentId) {
    return "answer_selected_intent";
  }
  return "answer_latest_unanswered";
}
