import { OpenRouter } from "@openrouter/sdk";
import {
  QuestionBankDifficulty,
  QuestionBankExtractionStatus,
  QuestionBankPrivacyRisk,
  QuestionBankQuestionType,
  QuestionBankVisibilityClass,
  SessionStatus,
} from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import {
  buildSanitizedQuestion,
  storeExtractedQuestion,
} from "./question-bank.service";
import type { ExtractedInterviewQuestion } from "./question-bank.types";

const EXTRACTION_MODEL =
  process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";

const ai = process.env.OPENROUTER_API_KEY
  ? new OpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
      httpReferer: "https://scribeshade.com",
      appTitle: "ScribeShade",
    })
  : null;

const terminalStatuses: SessionStatus[] = [
  SessionStatus.COMPLETED,
  SessionStatus.AUTO_ENDED,
  SessionStatus.CREDIT_EXHAUSTED,
];

const extractedQuestionSchema = z.object({
  rawDetectedQuestion: z.string().min(1),
  normalizedQuestion: z.string().min(1),
  visibilityClass: z.nativeEnum(QuestionBankVisibilityClass),
  privacyRisk: z.nativeEnum(QuestionBankPrivacyRisk),
  questionType: z.nativeEnum(QuestionBankQuestionType),
  difficulty: z.nativeEnum(QuestionBankDifficulty),
  complexityScore: z.number().int().min(0).max(100),
  technologies: z.array(z.string()).max(12),
  topics: z.array(z.string()).max(12),
  industry: z.string().optional(),
  roleGuess: z.string().optional(),
  companyGuess: z.string().optional(),
  confidence: z.number().min(0).max(1),
  rejectReason: z.string().optional(),
});

const extractionResponseSchema = z.object({
  questions: z.array(extractedQuestionSchema).max(30),
});

type SessionTranscriptEntry = {
  role?: string;
  sender?: string;
  content?: string;
  question?: string;
  answer?: string;
  time?: string;
  createdAt?: string;
};

function normalizeSpaces(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function stringifyTranscriptEntry(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const value = entry as SessionTranscriptEntry;
  const role = value.role || value.sender || "unknown";
  const content = value.content || value.question || "";
  if (!content.trim()) return "";
  return `[${role}] ${content}`;
}

function buildSessionExtractionText(input: {
  transcript: unknown;
  messages: unknown;
  questions: Array<{ id: string; ques: string }>;
}): string {
  const transcriptLines = Array.isArray(input.transcript)
    ? input.transcript.map(stringifyTranscriptEntry).filter(Boolean)
    : [];
  const messageLines = Array.isArray(input.messages)
    ? input.messages.map(stringifyTranscriptEntry).filter(Boolean)
    : [];
  const qaLines = input.questions.map((question, index) => `Saved question ${index + 1}: ${question.ques}`);

  return [...qaLines, ...transcriptLines, ...messageLines]
    .map(normalizeSpaces)
    .filter(Boolean)
    .slice(-250)
    .join("\n");
}

function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("AI response did not contain a JSON object");
  }
  return JSON.parse(match[0]);
}

function buildExtractionPrompt(input: {
  companyName: string;
  jobDescription: string;
  sourceText: string;
}): string {
  return [
    "Extract privacy-safe interview questions for ScribeShade Question Bank 2.0.",
    "Return only JSON with a top-level questions array.",
    "Use the enum values exactly as provided.",
    "Reject meeting noise, personal eligibility, salary, notice-period, relocation, camera/audio checks, and candidate-specific resume/project context.",
    "Generalize only when the question can be made candidate-safe without changing its meaning.",
    "",
    "Allowed visibilityClass values:",
    Object.values(QuestionBankVisibilityClass).join(", "),
    "Allowed privacyRisk values:",
    Object.values(QuestionBankPrivacyRisk).join(", "),
    "Allowed questionType values:",
    Object.values(QuestionBankQuestionType).join(", "),
    "Allowed difficulty values:",
    Object.values(QuestionBankDifficulty).join(", "),
    "",
    `Company hint: ${input.companyName}`,
    `Role/JD hint: ${input.jobDescription}`,
    "",
    "Source text:",
    input.sourceText,
  ].join("\n");
}

function findHardRejectReason(question: ExtractedInterviewQuestion): string | undefined {
  const combined = [
    question.rawDetectedQuestion,
    question.normalizedQuestion,
    question.companyGuess || "",
    question.roleGuess || "",
  ]
    .join(" ")
    .toLowerCase();

  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(combined)) {
    return "Question contains an email address";
  }
  if (/\b(?:\+?\d[\s-]?){8,}\b/.test(combined)) {
    return "Question contains a phone-like number";
  }
  if (/\b(linkedin|github\.com|meeting url|zoom link|google meet|teams link)\b/i.test(combined)) {
    return "Question contains private profile or meeting context";
  }
  if (/\b(salary|ctc|notice period|relocat|current location|expected pay|offer letter)\b/i.test(combined)) {
    return "Question contains personal eligibility context";
  }
  if (/\b(can you hear me|are you there|turn on your camera|share your screen|screen visible|interview is being recorded)\b/i.test(combined)) {
    return "Question is meeting noise";
  }
  if (/\b(your resume says|your cv says|your project at|you mentioned|your company|your current company)\b/i.test(combined)) {
    return "Question contains candidate-specific resume or project context";
  }
  if (!/[?]$/.test(normalizeSpaces(question.normalizedQuestion)) && question.normalizedQuestion.split(/\s+/).length < 5) {
    return "Detected text is not a clear interview question";
  }
  return undefined;
}

async function markRun(input: {
  sessionId: string;
  status: QuestionBankExtractionStatus;
  errorMessage?: string;
  extractedCount: number;
  acceptedCount: number;
  rejectedCount: number;
}): Promise<void> {
  await prisma.questionBankExtractionRun.upsert({
    where: { sessionId: input.sessionId },
    create: {
      sessionId: input.sessionId,
      status: input.status,
      startedAt:
        input.status === QuestionBankExtractionStatus.PROCESSING
          ? new Date()
          : undefined,
      completedAt:
        input.status !== QuestionBankExtractionStatus.PROCESSING
          ? new Date()
          : undefined,
      errorMessage: input.errorMessage,
      extractedCount: input.extractedCount,
      acceptedCount: input.acceptedCount,
      rejectedCount: input.rejectedCount,
    },
    update: {
      status: input.status,
      ...(input.status === QuestionBankExtractionStatus.PROCESSING
        ? { startedAt: new Date(), completedAt: null, errorMessage: null }
        : { completedAt: new Date() }),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
      extractedCount: input.extractedCount,
      acceptedCount: input.acceptedCount,
      rejectedCount: input.rejectedCount,
    },
  });
}

async function callExtractionModel(input: {
  companyName: string;
  jobDescription: string;
  sourceText: string;
}): Promise<ExtractedInterviewQuestion[]> {
  if (!ai) {
    throw new AppError(500, "OPENROUTER_API_KEY is required for question bank extraction");
  }

  const result = ai.callModel({
    model: EXTRACTION_MODEL,
    input: [
      {
        role: "system",
        type: "message",
        content:
          "You extract anonymized interview questions. You must return valid JSON only.",
      },
      {
        role: "user",
        type: "message",
        content: buildExtractionPrompt(input),
      },
    ],
    text: {
      format: { type: "json_object" },
    },
  });

  const content = await result.getText();
  if (!content) {
    throw new Error("AI extraction returned empty content");
  }

  const parsed = extractionResponseSchema.parse(extractJsonObject(content));
  return parsed.questions;
}

export async function runQuestionBankExtractionForSession(sessionId: string): Promise<void> {
  await markRun({
    sessionId,
    status: QuestionBankExtractionStatus.PROCESSING,
    extractedCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
  });

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        companyName: true,
        jobDescription: true,
        saveTranscription: true,
        questionBankContributionOptIn: true,
        status: true,
        transcript: true,
        messages: true,
        questions: {
          select: { id: true, ques: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!session) {
      throw new AppError(404, "Session not found for question bank extraction");
    }

    if (!terminalStatuses.includes(session.status)) {
      await markRun({
        sessionId,
        status: QuestionBankExtractionStatus.SKIPPED,
        errorMessage: `Session status ${session.status} is not terminal`,
        extractedCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
      });
      return;
    }

    if (session.saveTranscription === false) {
      await markRun({
        sessionId,
        status: QuestionBankExtractionStatus.SKIPPED,
        errorMessage: "Transcript saving is disabled for this session",
        extractedCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
      });
      return;
    }

    const sourceText = buildSessionExtractionText({
      transcript: session.transcript,
      messages: session.messages,
      questions: session.questions,
    });

    if (!sourceText) {
      await markRun({
        sessionId,
        status: QuestionBankExtractionStatus.SKIPPED,
        errorMessage: "No saved transcript or QA questions available",
        extractedCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
      });
      return;
    }

    const extractedQuestions = await callExtractionModel({
      companyName: session.companyName,
      jobDescription: session.jobDescription,
      sourceText,
    });

    let acceptedCount = 0;
    let rejectedCount = 0;

    for (const extracted of extractedQuestions) {
      const sanitizedQuestion = buildSanitizedQuestion({
        extracted,
        hardRejectReason: findHardRejectReason(extracted),
      });

      const stored = await storeExtractedQuestion({
        question: sanitizedQuestion,
        companyName: session.companyName,
        roleName: session.jobDescription,
        sourceUserId: session.userId,
        sourceSessionId: session.id,
        contributionOptIn: session.questionBankContributionOptIn,
      });

      if (stored.acceptedForPublicPool) {
        acceptedCount += 1;
      } else {
        rejectedCount += 1;
      }
    }

    await markRun({
      sessionId,
      status: QuestionBankExtractionStatus.COMPLETED,
      extractedCount: extractedQuestions.length,
      acceptedCount,
      rejectedCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown question bank extraction error";
    await markRun({
      sessionId,
      status: QuestionBankExtractionStatus.FAILED,
      errorMessage: message,
      extractedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
    });
    throw error;
  }
}
