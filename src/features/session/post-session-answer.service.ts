import { OpenRouter } from "@openrouter/sdk";
import {
  ChunkType,
  Prisma,
  SessionAnswerRevisionSource,
  SessionStatus,
  SpeakerType,
} from "@prisma/client";
import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import type {
  AnswerRevisionDto,
  ApplyAnswerInput,
  EditableAnswer,
  PostSessionAiMode,
} from "./post-session-answer.types";

const TERMINAL_STATUSES: SessionStatus[] = [
  SessionStatus.COMPLETED,
  SessionStatus.AUTO_ENDED,
  SessionStatus.CREDIT_EXHAUSTED,
  SessionStatus.FORCE_ENDED,
  SessionStatus.ABANDONED,
];

const POST_SESSION_MODEL =
  process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-4-5";

const ai = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY || "",
  httpReferer: "https://scribeshade.com",
  appTitle: "ScribeShade",
});

type LegacyMessage = {
  id?: string;
  messageId?: string;
  snapshotId?: string;
  role?: string;
  question?: string;
  answer?: string;
  content?: string;
  timestamp?: string;
  createdAt?: string;
  [key: string]: unknown;
};

type EditableSession = {
  id: string;
  userId: string;
  companyName: string;
  jobDescription: string;
  language: string;
  simpleLanguage: boolean;
  extraContext: string;
  status: SessionStatus;
  saveTranscription: boolean;
  messages: Prisma.JsonValue;
  transcript: Prisma.JsonValue;
};

export class StaleAnswerVersionError extends Error {
  readonly latestAnswer: string;
  readonly latestVersion: number;

  constructor(latestAnswer: string, latestVersion: number) {
    super("The answer changed after this editor was opened");
    this.name = "StaleAnswerVersionError";
    this.latestAnswer = latestAnswer;
    this.latestVersion = latestVersion;
  }
}

function asMessages(value: Prisma.JsonValue): LegacyMessage[] {
  return Array.isArray(value) ? (value as LegacyMessage[]) : [];
}

function messageKey(message: LegacyMessage): string {
  return String(
    message.messageId || message.id || message.snapshotId || "",
  ).trim();
}

function findAssistantMessage(
  session: Pick<EditableSession, "messages" | "transcript">,
  messageId: string,
): LegacyMessage | undefined {
  const candidates = [
    ...asMessages(session.messages),
    ...asMessages(session.transcript),
  ];
  return candidates.find(
    (message) =>
      message.role === "AI_ASSISTANT" && messageKey(message) === messageId,
  );
}

function extractQuestion(message: LegacyMessage): string {
  return String(message.question || "").trim();
}

function extractAnswer(message: LegacyMessage): string {
  const directAnswer = String(message.answer || "").trim();
  if (directAnswer) return directAnswer;
  const content = String(message.content || "").trim();
  const answerMatch = content.match(/\bA(?:NSWER)?:\s*([\s\S]*)/i);
  return answerMatch?.[1]?.trim() || content;
}

function resolveTimestamp(message: LegacyMessage): Date | undefined {
  const raw = message.timestamp || message.createdAt;
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function loadOwnedSession(
  sessionId: string,
  clerkId: string,
): Promise<EditableSession> {
  const session = await prisma.session.findFirst({
    where: {
      id: sessionId,
      user: { clerkId },
    },
    select: {
      id: true,
      userId: true,
      companyName: true,
      jobDescription: true,
      language: true,
      simpleLanguage: true,
      extraContext: true,
      status: true,
      saveTranscription: true,
      messages: true,
      transcript: true,
    },
  });

  if (!session) {
    throw new AppError(404, "Session not found");
  }
  if (!TERMINAL_STATUSES.includes(session.status)) {
    throw new AppError(409, "Only ended sessions can edit AI answers");
  }
  if (!session.saveTranscription) {
    throw new AppError(
      409,
      "Answers from sessions without saved transcripts cannot be edited",
    );
  }
  return session;
}

async function latestVersion(
  client: Prisma.TransactionClient | typeof prisma,
  sessionId: string,
  messageId: string,
): Promise<number> {
  const latest = await client.sessionAnswerRevision.findFirst({
    where: { sessionId, messageId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return latest?.version || 0;
}

async function resolveQa(
  client: Prisma.TransactionClient | typeof prisma,
  sessionId: string,
  messageId: string,
  question: string,
  answer: string,
  timestamp?: Date,
): Promise<{ id: string } | undefined> {
  const linked = await client.qA.findUnique({
    where: { messageId },
    select: { id: true },
  });
  if (linked) return linked;

  const candidates = await client.qA.findMany({
    where: {
      sessionId,
      ques: question,
      answer,
    },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return { id: candidates[0].id };
  if (!timestamp) {
    throw new AppError(
      409,
      "Multiple historical Q&A records match this answer",
    );
  }

  const ranked = candidates
    .map((candidate) => ({
      id: candidate.id,
      distance: Math.abs(
        candidate.createdAt.getTime() - timestamp.getTime(),
      ),
    }))
    .sort((left, right) => left.distance - right.distance);
  if (ranked[0].distance === ranked[1].distance) {
    throw new AppError(
      409,
      "Multiple historical Q&A records are equally close to this answer",
    );
  }
  return { id: ranked[0].id };
}

async function currentEditableAnswer(
  session: EditableSession,
  messageId: string,
): Promise<EditableAnswer> {
  const message = findAssistantMessage(session, messageId);
  if (!message) {
    throw new AppError(404, "AI answer not found");
  }
  const question = extractQuestion(message);
  const answer = extractAnswer(message);
  if (!question || !answer) {
    throw new AppError(409, "The selected AI answer is incomplete");
  }
  const timestamp = resolveTimestamp(message);
  const [currentVersion, qa] = await Promise.all([
    latestVersion(prisma, session.id, messageId),
    resolveQa(
      prisma,
      session.id,
      messageId,
      question,
      answer,
      timestamp,
    ),
  ]);
  return {
    sessionId: session.id,
    messageId,
    userId: session.userId,
    question,
    answer,
    currentVersion,
    qaId: qa?.id,
    timestamp: timestamp?.toISOString(),
  };
}

function rewriteMessages(
  value: Prisma.JsonValue,
  messageId: string,
  answer: string,
  version: number,
): LegacyMessage[] {
  return asMessages(value).map((message) => {
    if (
      message.role !== "AI_ASSISTANT" ||
      messageKey(message) !== messageId
    ) {
      return message;
    }
    const question = extractQuestion(message);
    return {
      ...message,
      messageId,
      answer,
      content: `Q: ${question}\n\nA: ${answer}`,
      answerVersion: version,
      answerEditedAt: new Date().toISOString(),
    };
  });
}

function modeInstruction(mode: PostSessionAiMode, instruction?: string): string {
  if (mode === "improve") {
    return "Improve clarity, correctness, structure, and interview usefulness without making the answer unnecessarily longer.";
  }
  if (mode === "shorten") {
    return "Make the answer substantially shorter and more direct while retaining the essential reasoning and any necessary code.";
  }
  if (mode === "expand") {
    return "Expand the answer with deeper reasoning, practical details, tradeoffs, and examples that are useful in an interview.";
  }
  if (mode === "simplify") {
    return "Rewrite the answer in simpler language while preserving technical accuracy.";
  }
  if (mode === "regenerate") {
    return "Generate a fresh, high-quality answer to the question. Do not copy the existing answer's structure.";
  }
  return instruction?.trim() || "";
}

export async function createAnswerPreview(
  sessionId: string,
  messageId: string,
  clerkId: string,
  mode: PostSessionAiMode,
  instruction: string | undefined,
  baseVersion: number,
): Promise<{ stream: AsyncIterable<string>; model: string }> {
  const session = await loadOwnedSession(sessionId, clerkId);
  const target = await currentEditableAnswer(session, messageId);
  if (target.currentVersion !== baseVersion) {
    throw new StaleAnswerVersionError(
      target.answer,
      target.currentVersion,
    );
  }
  const editingInstruction = modeInstruction(mode, instruction);
  if (!editingInstruction) {
    throw new AppError(400, "A custom editing instruction is required");
  }

  const nearbyContext = asMessages(session.messages)
    .filter((message) => messageKey(message) !== messageId)
    .slice(-8)
    .map((message) => {
      const text =
        message.role === "AI_ASSISTANT"
          ? extractAnswer(message)
          : String(message.question || message.content || "").trim();
      return `${message.role || "UNKNOWN"}: ${text.slice(0, 1000)}`;
    })
    .join("\n\n");

  const result = ai.callModel({
    model: POST_SESSION_MODEL,
    maxOutputTokens: 3000,
    store: false,
    sessionId,
    input: [
      {
        role: "system",
        type: "message",
        content:
          "You edit a completed interview answer. Return only the revised answer in Markdown. Do not include commentary, labels, analysis, or fenced wrappers around the whole response. Preserve factual claims and code unless the instruction explicitly requires a fresh regeneration.",
      },
      {
        role: "user",
        type: "message",
        content: [
          `Company: ${session.companyName}`,
          `Role or job description: ${session.jobDescription}`,
          `Language preference: ${session.language}`,
          `Use simple language: ${session.simpleLanguage ? "yes" : "no"}`,
          `Session instructions: ${session.extraContext || "none"}`,
          `Editing instruction: ${editingInstruction}`,
          `Question:\n${target.question}`,
          `Current answer:\n${target.answer}`,
          nearbyContext
            ? `Nearby session context:\n${nearbyContext}`
            : "Nearby session context: none",
        ].join("\n\n"),
      },
    ],
  });

  return {
    stream: result.getTextStream(),
    model: POST_SESSION_MODEL,
  };
}

export async function listAnswerRevisions(
  sessionId: string,
  messageId: string,
  clerkId: string,
): Promise<{
  answer: string;
  currentVersion: number;
  revisions: AnswerRevisionDto[];
}> {
  const session = await loadOwnedSession(sessionId, clerkId);
  const target = await currentEditableAnswer(session, messageId);
  const revisions = await prisma.sessionAnswerRevision.findMany({
    where: { sessionId, messageId },
    orderBy: { version: "desc" },
  });
  return {
    answer: target.answer,
    currentVersion: target.currentVersion,
    revisions: revisions.map((revision) => ({
      id: revision.id,
      version: revision.version,
      question: revision.question,
      answer: revision.answer,
      source: revision.source.toLowerCase(),
      aiMode: revision.aiMode || undefined,
      instruction: revision.instruction || undefined,
      model: revision.model || undefined,
      createdAt: revision.createdAt.toISOString(),
    })),
  };
}

export async function applyAnswerEdit(
  sessionId: string,
  messageId: string,
  clerkId: string,
  input: ApplyAnswerInput,
): Promise<{
  answer: string;
  currentVersion: number;
  revisionId: string;
}> {
  const normalizedAnswer = input.answer.trim();
  if (!normalizedAnswer) {
    throw new AppError(400, "Answer is required");
  }
  const session = await loadOwnedSession(sessionId, clerkId);

  try {
    return await prisma.$transaction(
      async (tx) => {
      const liveSession = await tx.session.findUnique({
        where: { id: session.id },
        select: {
          id: true,
          userId: true,
          messages: true,
          transcript: true,
        },
      });
      if (!liveSession) throw new AppError(404, "Session not found");

      const currentMessage = findAssistantMessage(liveSession, messageId);
      if (!currentMessage) throw new AppError(404, "AI answer not found");
      const currentQuestion = extractQuestion(currentMessage);
      const currentAnswer = extractAnswer(currentMessage);
      const currentVersion = await latestVersion(tx, sessionId, messageId);
      if (currentVersion !== input.baseVersion) {
        throw new StaleAnswerVersionError(currentAnswer, currentVersion);
      }

      const timestamp = resolveTimestamp(currentMessage);
      const qa = await resolveQa(
        tx,
        sessionId,
        messageId,
        currentQuestion,
        currentAnswer,
        timestamp,
      );
      if (qa) {
        await tx.qA.update({
          where: { id: qa.id },
          data: { messageId, answer: normalizedAnswer },
        });
      }

      const chunk = await tx.transcriptChunk.findFirst({
        where: {
          sessionId,
          questionId: messageId,
          speakerType: SpeakerType.ASSISTANT,
        },
        select: { id: true },
      });
      if (chunk) {
        await tx.transcriptChunk.update({
          where: { id: chunk.id },
          data: {
            question: currentQuestion,
            aiAnswer: normalizedAnswer,
            content: `Q: ${currentQuestion}\n\nA: ${normalizedAnswer}`,
          },
        });
      } else {
        await tx.transcriptChunk.create({
          data: {
            sessionId,
            userId: liveSession.userId,
            questionId: messageId,
            question: currentQuestion,
            aiAnswer: normalizedAnswer,
            content: `Q: ${currentQuestion}\n\nA: ${normalizedAnswer}`,
            technologies: [],
            speakerType: SpeakerType.ASSISTANT,
            chunkType: ChunkType.ANSWER,
            questionGroupId: "live-transcript",
            startTime: timestamp?.getTime(),
            isQuestion: false,
          },
        });
      }

      let nextVersion = currentVersion + 1;
      if (currentVersion === 0) {
        await tx.sessionAnswerRevision.create({
          data: {
            sessionId,
            messageId,
            qaId: qa?.id,
            userId: liveSession.userId,
            version: 1,
            question: currentQuestion,
            answer: currentAnswer,
            source: SessionAnswerRevisionSource.ORIGINAL,
          },
        });
        nextVersion = 2;
      }

      const revision = await tx.sessionAnswerRevision.create({
        data: {
          sessionId,
          messageId,
          qaId: qa?.id,
          userId: liveSession.userId,
          version: nextVersion,
          question: currentQuestion,
          answer: normalizedAnswer,
          source: input.source,
          aiMode: input.aiMode,
          instruction: input.instruction?.trim() || undefined,
          model: input.model,
        },
      });

      await tx.session.update({
        where: { id: sessionId },
        data: {
          messages: rewriteMessages(
            liveSession.messages,
            messageId,
            normalizedAnswer,
            nextVersion,
          ) as Prisma.InputJsonValue,
          transcript: rewriteMessages(
            liveSession.transcript,
            messageId,
            normalizedAnswer,
            nextVersion,
          ) as Prisma.InputJsonValue,
        },
      });

      return {
        answer: normalizedAnswer,
        currentVersion: nextVersion,
        revisionId: revision.id,
      };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2002" || error.code === "P2034")
    ) {
      const latestSession = await loadOwnedSession(sessionId, clerkId);
      const latest = await currentEditableAnswer(latestSession, messageId);
      throw new StaleAnswerVersionError(
        latest.answer,
        latest.currentVersion,
      );
    }
    throw error;
  }
}

export async function restoreAnswerRevision(
  sessionId: string,
  messageId: string,
  revisionId: string,
  clerkId: string,
  baseVersion: number,
): Promise<{
  answer: string;
  currentVersion: number;
  revisionId: string;
}> {
  const revision = await prisma.sessionAnswerRevision.findFirst({
    where: {
      id: revisionId,
      sessionId,
      messageId,
      session: { user: { clerkId } },
    },
    select: { answer: true },
  });
  if (!revision) {
    throw new AppError(404, "Answer revision not found");
  }
  return applyAnswerEdit(sessionId, messageId, clerkId, {
    answer: revision.answer,
    baseVersion,
    source: SessionAnswerRevisionSource.RESTORE,
    instruction: `Restored revision ${revisionId}`,
  });
}
