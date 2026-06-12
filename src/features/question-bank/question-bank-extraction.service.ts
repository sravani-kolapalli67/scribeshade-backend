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

// LLMs frequently emit `null` for fields they could simply omit. Zod's
// `.optional()` accepts `undefined` but NOT `null`, and `.default([])` only
// fills in for `undefined` — so a literal `null` from the model throws. These
// helpers coerce null → the expected empty value so a stray null never sinks an
// otherwise-valid question.
const optionalString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => (typeof value === "string" && value.trim() ? value.trim() : undefined));

const optionalStringArray = z
  .array(z.union([z.string(), z.null()]))
  .nullish()
  .transform((value) =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => item.trim())
          .slice(0, 12)
      : [],
  );

export const extractedQuestionSchema = z.object({
  rawDetectedQuestion: z.string().min(1),
  normalizedQuestion: z.string().min(1),
  visibilityClass: z.nativeEnum(QuestionBankVisibilityClass),
  privacyRisk: z.nativeEnum(QuestionBankPrivacyRisk),
  questionType: z.nativeEnum(QuestionBankQuestionType),
  difficulty: z.nativeEnum(QuestionBankDifficulty),
  complexityScore: z.number().int().min(0).max(100),
  technologies: optionalStringArray,
  topics: optionalStringArray,
  industry: optionalString,
  roleGuess: optionalString,
  companyGuess: optionalString,
  confidence: z.number().min(0).max(1),
  rejectReason: optionalString,
});

export const extractionResponseSchema = z.object({
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
    "Return ONLY a JSON object with a single top-level key \"questions\" whose value is an array.",
    "Use the enum values exactly as listed below — do not invent other values.",
    "Reject meeting noise, personal eligibility, salary, notice-period, relocation, camera/audio checks, and candidate-specific resume/project context.",
    "Generalize only when the question can be made candidate-safe without changing its meaning.",
    "",
    "Each object in the questions array MUST contain exactly these fields (no other field names are allowed):",
    "  rawDetectedQuestion   (string)  — verbatim question text as detected in the source",
    "  normalizedQuestion    (string)  — cleaned, candidate-safe, generalised version",
    "  visibilityClass       (string)  — one of: " + Object.values(QuestionBankVisibilityClass).join(", "),
    "  privacyRisk           (string)  — one of: " + Object.values(QuestionBankPrivacyRisk).join(", "),
    "  questionType          (string)  — one of: " + Object.values(QuestionBankQuestionType).join(", "),
    "  difficulty            (string)  — one of: " + Object.values(QuestionBankDifficulty).join(", "),
    "  complexityScore       (integer 0–100) — technical complexity",
    "  technologies          (array of strings, max 12) — specific technologies; use [] if none",
    "  topics                (array of strings, max 12) — conceptual topics; use [] if none",
    "  industry              (string, optional) — inferred industry; omit if unknown",
    "  roleGuess             (string, optional) — inferred role title; omit if unknown",
    "  companyGuess          (string, optional) — guessed company; omit if not identifiable",
    "  confidence            (number 0–1) — your confidence this is a real interview question",
    "  rejectReason          (string, optional) — reason not to publish; omit if publishable",
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
    instructions: "You extract anonymized interview questions. You must return valid JSON only.",
    input: buildExtractionPrompt(input),
    text: {
      format: { type: "json_object" },
    },
  });

  const content = await result.getText();
  if (!content) {
    throw new Error("AI extraction returned empty content");
  }

  const rawParsed = extractJsonObject(content);
  const questionsRaw = Array.isArray((rawParsed as Record<string, unknown>)?.questions)
    ? (rawParsed as Record<string, unknown>).questions
    : null;
  console.info("[question-bank-extraction] raw extraction shape", {
    topLevelKeys: rawParsed && typeof rawParsed === "object" ? Object.keys(rawParsed as object) : "not-an-object",
    questionCount: Array.isArray(questionsRaw) ? questionsRaw.length : "not-an-array",
    firstQuestionKeys:
      Array.isArray(questionsRaw) && questionsRaw.length > 0 && typeof questionsRaw[0] === "object" && questionsRaw[0]
        ? Object.keys(questionsRaw[0] as object)
        : "none",
  });

  // Parse each question independently so a single malformed entry (bad enum,
  // missing required text, etc.) is dropped instead of discarding the whole
  // batch. The null-tolerant field helpers above already absorb stray nulls.
  const candidateArray = Array.isArray(questionsRaw) ? questionsRaw : [];
  const parsedQuestions: ExtractedInterviewQuestion[] = [];
  let droppedCount = 0;
  for (const candidate of candidateArray.slice(0, 30)) {
    const result = extractedQuestionSchema.safeParse(candidate);
    if (result.success) {
      parsedQuestions.push(result.data);
    } else {
      droppedCount += 1;
      console.warn("[question-bank-extraction] dropped invalid question", {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
  }
  if (droppedCount > 0) {
    console.warn("[question-bank-extraction] dropped questions during parse", {
      droppedCount,
      keptCount: parsedQuestions.length,
    });
  }
  return parsedQuestions;
}

export async function runQuestionBankExtractionForSession(sessionId: string): Promise<void> {
  // Fetch the session BEFORE marking the run as PROCESSING. The extraction-run
  // row has a non-nullable FK to Session with onDelete: Cascade, so if the
  // session was already deleted the run row is gone too and markRun() would
  // throw an FK violation. A deleted session is permanent and unprocessable —
  // return cleanly (no throw) so BullMQ does not retry it 3× with noisy logs.
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
    console.warn("[question-bank-extraction] session not found, skipping", { sessionId });
    return;
  }

  await markRun({
    sessionId,
    status: QuestionBankExtractionStatus.PROCESSING,
    extractedCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
  });

  try {
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
    let failedCount = 0;

    for (const extracted of extractedQuestions) {
      const sanitizedQuestion = buildSanitizedQuestion({
        extracted,
        hardRejectReason: findHardRejectReason(extracted),
      });

      // Isolate each question: a single un-storable entry (e.g. neither the
      // session nor the AI provided a company/role, or a transient DB error)
      // must not abort the whole batch and fail the job. Count and continue.
      try {
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
      } catch (storeError) {
        failedCount += 1;
        console.warn("[question-bank-extraction] skipped question that could not be stored", {
          sessionId,
          reason: storeError instanceof Error ? storeError.message : String(storeError),
        });
      }
    }

    if (failedCount > 0) {
      console.warn("[question-bank-extraction] some questions were not stored", {
        sessionId,
        failedCount,
        acceptedCount,
        rejectedCount,
      });
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
