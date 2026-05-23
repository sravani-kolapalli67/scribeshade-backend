import { z } from "zod";

export const AI_ANSWER_LIMITS = {
  recentTranscriptWindowMax: 15,
  previousAiAnswerMaxChars: 1000,
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

const speakerEntrySchema = z.object({
  speakerType: speakerTypeSchema,
  content: z.string().trim().min(1),
  timestamp: z.number().optional(),
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

export const aiAnswerRequestSchema = z.object({
  transcript: z.string().trim().min(1),
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
  answerMode: answerModeSchema.optional(),
  sourcePlatform: sourcePlatformSchema.optional(),
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
>;

export interface NormalizedAIAnswerRequest {
  resolvedQuestion: string;
  resolvedFrom?: "patchedTranscript" | "currentQuestion" | "transcript" | "none";
  liveContextMetadata?: AIAnswerLiveContextMetadata;
}

export function normalizeAIAnswerRequestBody(
  body: any,
): NormalizedAIAnswerRequest {
  if (typeof body?.transcript !== "string") {
    return { resolvedQuestion: "", resolvedFrom: "none" };
  }

  // Keep a defensive cap path in backend too.
  const clipped = {
    ...body,
    previousAiAnswer:
      typeof body.previousAiAnswer === "string"
        ? body.previousAiAnswer.slice(0, AI_ANSWER_LIMITS.previousAiAnswerMaxChars)
        : body.previousAiAnswer,
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
  const resolvedFrom = dto.patchedTranscript?.trim()
    ? "patchedTranscript"
    : dto.currentQuestion?.trim()
      ? "currentQuestion"
      : "transcript";
  const resolvedQuestion = resolvedFrom === "patchedTranscript"
    ? dto.patchedTranscript!.trim()
    : resolvedFrom === "currentQuestion"
      ? dto.currentQuestion!.trim()
      : dto.transcript.trim();

  const { transcript, currentQuestion, patchedTranscript, ...liveContextMetadata } = dto;
  return {
    resolvedQuestion,
    resolvedFrom,
    liveContextMetadata:
      Object.keys(liveContextMetadata).length > 0 ? liveContextMetadata : undefined,
  };
}
