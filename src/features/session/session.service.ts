import { prisma } from "../../shared/lib/prisma";
import { OpenRouter } from "@openrouter/sdk";
import { CreateSessionData } from "./session.types";
import * as qaService from "../qa/qa.service";
import sharp from "sharp";
import { Language, Industry, SessionStatus, Prisma } from "@prisma/client";
import * as documentService from "../document/document.service";
import path from "path";
import { AppError } from "../../shared/middleware/error.middleware";
import * as creditsService from "../credits/credits.service";
import { creditDeductionQueue } from "../../jobs/queue";

const ai = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY || "",
  httpReferer: "https://scribeshade.com",
  appTitle: "ScribeShade",
});

const model = process.env.OPENROUTER_MODEL;

/** Normalize human-readable model names sent by frontend to valid OpenRouter slugs */
const MODEL_ID_MAP: Record<string, string> = {
  "gemini 2.0 flash": "google/gemini-2.0-flash-001",
  "gemini 2.0 flash exp": "google/gemini-2.0-flash-exp:free",
  "gemini 1.5 flash": "google/gemini-flash-1.5",
  "gemini 1.5 pro": "google/gemini-pro-1.5",
  "gpt-4o": "openai/gpt-4o",
  "gpt-4o mini": "openai/gpt-4o-mini",
  "claude 3.5 sonnet": "anthropic/claude-3.5-sonnet",
  "claude 3 haiku": "anthropic/claude-3-haiku",
};

function resolveModelId(id: string | undefined): string | undefined {
  if (!id) return id;
  const normalized = id.toLowerCase().trim();
  return MODEL_ID_MAP[normalized] ?? id;
}

/**
 * Maps a session language string to a Prisma Language enum value.
 */
function mapLanguage(lang: string): Language {
  const l = (lang || "").toLowerCase().trim();
  if (l.includes("javascript") || l === "js") return Language.JavaScript;
  if (l.includes("typescript") || l === "ts") return Language.TypeScript;
  if (l.includes("python") || l === "py") return Language.Python;
  if (l === "java") return Language.Java;
  if (l.includes("c++") || l === "cpp" || l.includes("plus plus"))
    return Language.C_Plus_Plus;
  if (l === "c") return Language.C;
  if (l.includes("c#") || l === "csharp" || l.includes("c sharp"))
    return Language.C_Sharp;
  if (l === "go" || l === "golang") return Language.Go;
  return Language.General;
}

/**
 * Maps a job description to a Prisma Industry enum value based on keywords.
 */
function mapIndustry(jobDesc: string): Industry {
  const j = (jobDesc || "").toLowerCase().trim();
  if (
    j.includes("frontend") ||
    j.includes("backend") ||
    j.includes("full stack") ||
    j.includes("fullstack") ||
    j.includes("react") ||
    j.includes("node") ||
    j.includes("web")
  )
    return Industry.Full_Stack;
  if (
    j.includes("data") ||
    j.includes("ml") ||
    j.includes("machine learning") ||
    j.includes("ai")
  )
    return Industry.Data_Science;
  if (
    j.includes("devops") ||
    j.includes("sre") ||
    j.includes("docker") ||
    j.includes("kubernetes") ||
    j.includes("infra")
  )
    return Industry.DevOps;
  if (
    j.includes("mobile") ||
    j.includes("ios") ||
    j.includes("android") ||
    j.includes("flutter")
  )
    return Industry.Mobile;
  if (
    j.includes("aws") ||
    j.includes("azure") ||
    j.includes("gcp") ||
    j.includes("cloud")
  )
    return Industry.Cloud;
  if (j.includes("architect") || j.includes("system design"))
    return Industry.System_Design;
  return Industry.DSA;
}

/**
 * Creates a new interview session.
 */
export async function createSession(data: CreateSessionData) {
  let finalCompanyId = "";

  if (data.companyName) {
    // Generate a basic slug
    let baseSlug = data.companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "");
    if (!baseSlug) baseSlug = `company-${Date.now()}`;

    // Find or create the company
    let company = await prisma.company.findFirst({
      where: { name: { equals: data.companyName, mode: "insensitive" } },
    });

    if (!company) {
      // Ensure slug uniqueness simple fallback
      const existingSlug = await prisma.company.findUnique({
        where: { slug: baseSlug },
      });
      if (existingSlug) {
        baseSlug = `${baseSlug}-${Math.floor(Math.random() * 10000)}`;
      }

      company = await prisma.company.create({
        data: {
          name: data.companyName,
          slug: baseSlug,
        },
      });
    }

    finalCompanyId = company.id;
  }

  return prisma.session.create({
    data: {
      userId: data.userId,
      companyName: data.companyName || "",
      companyId: finalCompanyId,
      jobDescription: data.jobDescription || "",
      resumeId: data.resumeId || "",
      DocumentId: data.DocumentId || "",
      language: data.language || "",
      simpleLanguage: data.simpleLanguage,
      extraContext: data.extraContext || "",
      autoGenerateResponse: data.autoGenerateResponse,
      saveTranscription: data.saveTranscription,
      mode: data.mode,
      free: data.free,
      status: SessionStatus.PRE_CHECK,
    },
  });
}

/**
 * Returns all sessions for a specific user with optional filters.
 */
export async function getSessionsByUser(
  userId: string,
  filters?: { search?: string; from_date?: string; to_date?: string }
) {
  const where: any = { userId };

  if (filters?.search) {
    where.companyName = { contains: filters.search, mode: "insensitive" };
  }

  if (filters?.from_date || filters?.to_date) {
    where.createdAt = {};
    if (filters.from_date) {
      where.createdAt.gte = new Date(filters.from_date);
    }
    if (filters.to_date) {
      const to = new Date(filters.to_date);
      to.setHours(23, 59, 59, 999);
      where.createdAt.lte = to;
    }
  }

  return prisma.session.findMany({
    where,
    include: { feedback: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Returns a specific session by ID.
 */
export async function getSessionById(id: string) {
  return prisma.session.findUnique({
    where: { id },
    include: { feedback: true },
  });
}

/**
 * Deletes a session by ID.
 */
export async function deleteSession(id: string) {
  // Release hold if session is still in PRE_CHECK (never activated)
  const session = await prisma.session.findUnique({ where: { id } });
  if (
    session &&
    session.status === SessionStatus.PRE_CHECK &&
    new Prisma.Decimal(session.creditsHeld.toString()).gt(0)
  ) {
    await prisma.$transaction(async (tx) => {
      await creditsService.releaseHold(
        session.userId,
        new Prisma.Decimal(session.creditsHeld.toString()),
        tx,
      );
    });
  }

  return prisma.session.delete({
    where: { id },
  });
}

/**
 * Activates a session (sets status to ACTIVE, places a credit hold, records start time).
 * Runs inside a $transaction to atomically update both balance and session.
 */
export async function activateSession(id: string) {
  return prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({ where: { id } });
    if (!session) throw new AppError(404, "Session not found");

    // Idempotent — already ACTIVE
    if (session.status === SessionStatus.ACTIVE) {
      return session;
    }

    if (session.status !== SessionStatus.PRE_CHECK) {
      throw new AppError(409, `Cannot activate session in status ${session.status}`);
    }

    let creditsHeld: Prisma.Decimal = new Prisma.Decimal(0);
    let maxAllowedMinutes: number | null = null;
    let bracketConfigSnapshot: unknown = null;

    // Place credit hold for paid sessions only
    if (!session.free) {
      const holdResult = await creditsService.placeHold(session.userId, tx);
      creditsHeld = new Prisma.Decimal(holdResult.creditsHeld);
      maxAllowedMinutes = holdResult.maxAllowedMinutes;
      bracketConfigSnapshot = holdResult.snapshot;
    }

    return tx.session.update({
      where: { id },
      data: {
        status: SessionStatus.ACTIVE,
        startedAt: new Date(),
        creditsHeld,
        maxAllowedMinutes,
        bracketConfigSnapshot: bracketConfigSnapshot as any,
      },
    });
  });
}

/**
 * Deactivates a session (sets status to COMPLETING, records end time, enqueues deduction job).
 */
export async function deactivateSession(
  id: string,
  aiUsage?: number | null,
  transcript?: string,
) {
  const usageCount =
    typeof aiUsage === "number" ? aiUsage : parseInt(aiUsage as any, 10);

  const { session, didTransition } = await prisma.$transaction(async (tx) => {
    const s = await tx.session.findUnique({ where: { id } });
    if (!s) throw new Error("Session not found");

    // Idempotency guard — already closed or in-flight
    if (
      s.status === SessionStatus.COMPLETED ||
      s.status === SessionStatus.COMPLETING ||
      s.status === SessionStatus.CREDIT_EXHAUSTED ||
      s.status === SessionStatus.FORCE_ENDED
    ) {
      return { session: s, didTransition: false };
    }

    if (s.status !== SessionStatus.ACTIVE && s.status !== SessionStatus.PAUSED) {
      throw new AppError(409, `Cannot deactivate session in status ${s.status}`);
    }

    const updated = await tx.session.update({
      where: { id },
      data: {
        status: SessionStatus.COMPLETING,
        endedAt: new Date(),
        ...(!isNaN(usageCount) && usageCount > 0
          ? { aiUsage: { increment: usageCount } }
          : {}),
      },
    });
    return { session: updated, didTransition: true };
  });

  // Enqueue deduction job only when we actually transitioned to COMPLETING
  if (didTransition && session.status === SessionStatus.COMPLETING) {
    if (session.bracketConfigSnapshot) {
      await creditDeductionQueue.add("credit-deduction", {
        sessionId: id,
        userId: session.userId,
      });
    } else {
      // Free session — mark COMPLETED synchronously
      await prisma.session.update({
        where: { id },
        data: { status: SessionStatus.COMPLETED },
      });
    }
  }

  return session;
}

/**
 * Force-closes a session as CREDIT_EXHAUSTED and enqueues a deduction job with the exhausted flag.
 * Called by the heartbeat endpoint or session watchdog.
 * @param sessionId Session UUID
 * @param dbUserId  Internal (DB) user UUID — not Clerk ID
 */
export async function creditExhaustionClose(sessionId: string, dbUserId: string) {
  await prisma.$transaction(async (tx) => {
    const s = await tx.session.findUnique({ where: { id: sessionId } });
    if (!s || s.status !== SessionStatus.ACTIVE) return;

    await tx.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.CREDIT_EXHAUSTED,
        endedAt: new Date(),
        creditExhaustedAt: new Date(),
      },
    });
  });

  await creditDeductionQueue.add("credit-deduction", {
    sessionId,
    userId: dbUserId,
    isExhausted: true,
  });
}

/**
 * Aggregates all available context for a session (JD, Resume, Documents, Instructions).
 */
export async function getSessionFullContext(sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { company: true },
  });

  if (!session) return null;

  // 1. Fetch Resume context
  let resumeContext = "";
  if (session.resumeId) {
    try {
      const resume = await prisma.resume.findUnique({
        where: { id: session.resumeId },
      });
      resumeContext = resume?.resumeContext || "";
    } catch (e) {
      console.warn("Failed to fetch resume context:", e);
    }
  }

  // 2. Fetch Document context
  let documentText = "";
  if (session.DocumentId) {
    try {
      const doc = await prisma.document.findUnique({
        where: { id: session.DocumentId },
      });
      if (doc) {
        const ext = path.extname(doc.path).toLowerCase();
        documentText = await documentService.extractTextFromFile(doc.path, ext);
      }
    } catch (e) {
      console.warn("Failed to fetch document context:", e);
    }
  }

  // 3. Fetch recent message history for conversation context
  const messages = Array.isArray(session.messages)
    ? (session.messages as any[])
    : [];
  const recentHistory = messages
    .slice(-5) // Last 5 messages for context
    .map((m) => `Q: ${m.question}\nA: ${m.answer}`)
    .join("\n\n");

  return {
    company: session.company?.name || session.companyName || "Unknown",
    role: session.jobDescription || "Interviewee",
    language: session.language || "General",
    simpleLanguage: session.simpleLanguage,
    instructions: session.extraContext || "None",
    resume: resumeContext || "No resume context provided.",
    document: documentText ? documentText.substring(0, 5000) : "None",
    history: recentHistory || "No previous interactions in this session.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — shared across all interview AI calls.
// Passed as role:"system" so the model treats it as a hard behavioral constraint.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Builds the dynamic system prompt combining static rules with session context.
 */
function buildSystemMessage(context: any) {
  return [
    "You are an expert AI Interview Assistant embedded inside a live interview tool.",
    "Your role is to silently help the candidate by identifying questions and providing precise, natural, well-structured answers tailored to their background.",
    "",
    "### Session Context:",
    `- Company: ${context?.company}`,
    `- Role: ${context?.role}`,
    `- Technical Stack: ${context?.language}`,
    `- Simple Language Mode: ${context?.simpleLanguage ? "ENABLED (Use clear, plain English)" : "DISABLED"}`,
    "",
    "### Recent Conversation History:",
    context?.history || "No previous interactions.",
    "",
    "### Candidate Background (Resume):",
    context?.resume || "No resume provided.",
    "",
    "### Supporting Material (Documents):",
    context?.document || "None provided.",
    "",
    "### User's Special Instructions:",
    context?.instructions || "None.",
    "",
    "### Formatting Rules (STRICT):",
    "- Start answers with a natural paragraph (like a human speaking), especially for introductions, explanations, and conceptual answers.",
    "- NEVER use bullet points for introductions, definitions, or high-level explanations.",
    "- Use bullet points ONLY when listing items, steps, comparisons, or multiple distinct points.",
    "- If the answer can be explained clearly in 1–2 paragraphs, DO NOT use bullets at all.",
    "- Maintain a conversational, interview-ready tone (similar to how a strong candidate would respond verbally).",
    "- Avoid over-structuring; do NOT force bullets unless necessary.",
    "- Minimize bold: only use **double asterisks** for the single most critical technical term per paragraph or section.",
    "- **Code Implementation**: If the question is technical or asks for logic, ALWAYS provide a clean, high-quality code implementation.",
    "- **Code Block Formatting**: Use Markdown code blocks with the correct language tag (e.g., ```javascript or ```python).",
    '- Do NOT include meta sections like "Summary", "Conclusion", or "Complexity Analysis" unless explicitly asked.',
    '- Do NOT include question numbers or labels (e.g. "1.", "Q:", "Question 1") in the extracted question.',
    "",
    "### Response Format (ALWAYS use this exact structure):",
    "**QUESTION:**",
    "[the interview question, without any numbering or prefix]",
    "",
    "**ANSWER:**",
    "[your answer — natural paragraphs, selective bullets, and mandatory code blocks for technical questions]",
  ].join("\n");
}

/**
 * Shared helper to handle AI stream generation and post-processing (saving to DB).
 */
function processAIStream(
  result: any,
  session: any,
  sessionId: string,
  fallbackQuestion: string,
) {
  async function* streamGenerator() {
    let fullResponse = "";
    let lastYieldedLength = 0;

    for await (const item of result.getItemsStream()) {
      if (item.type === "message") {
        const textContent = item.content?.find(
          (c: any) => c.type === "output_text",
        );
        if (textContent && "text" in textContent) {
          const currentText = textContent.text;
          const delta = currentText.slice(
            Math.max(lastYieldedLength, fullResponse.length),
          );
          if (delta) {
            yield { text: delta };
            lastYieldedLength = currentText.length;
          }
          fullResponse = currentText;
        }
      }
    }

    // Post-processing: extract Q&A and persist (fire-and-forget)
    (async () => {
      try {
        const finalResponse = await result.getText();
        const questionMatch = finalResponse.match(
          /QUESTION:\*?\*?\s*([\s\S]*?)\s*\*?\*?ANSWER:/i,
        );
        const answerMatch = finalResponse.match(/ANSWER:\*?\*?\s*([\s\S]*)/i);
        const extractedQuestion =
          questionMatch?.[1]
            ?.trim()
            ?.replace(
              /^(\d+[\s.)-]+\s*|Question\s*\d+[:\s-]*|Q\d+[:\s-]*)/i,
              "",
            ) || fallbackQuestion;
        const extractedAnswer = answerMatch?.[1]?.trim() || finalResponse;

        if (extractedAnswer && session) {
          await qaService
            .createQA({
              userId: session.userId,
              sessionId,
              companyId: session.companyId,
              ques: extractedQuestion,
              answer: extractedAnswer,
              language: mapLanguage(session.language),
              industry: mapIndustry(session.jobDescription),
            })
            .catch((e) => console.error("Auto-save QA Error:", e));

          await appendMessage(
            sessionId,
            "AI_ASSISTANT",
            extractedQuestion,
            extractedAnswer,
          ).catch((e) => console.error("appendMessage Error:", e));
        }
      } catch (e) {
        console.error("Post-processing Error:", e);
      }
    })();
  }
  return streamGenerator();
}

/**
 * Analyzes a provided screenshot within a session context.
 * Uses a single AI call — the model returns QUESTION + ANSWER in one response.
 */
export async function analyzeScreen(
  id: string,
  file: Express.Multer.File,
  aiModel?: string,
) {
  // Parallelize image compression and DB fetch for lower latency
  const [compressed, session] = await Promise.all([
    sharp(file.buffer)
      .resize({ width: 800 })
      .jpeg({ quality: 60 })
      .toBuffer()
      .catch((err) => {
        console.error("Sharp compression error:", err);
        throw err;
      }),
    prisma.session.findUnique({
      where: { id },
      include: { company: true },
    }),
  ]);

  if (!session) {
    throw new Error("Session not found");
  }

  const context = await getSessionFullContext(id);

  try {
    const targetModel = resolveModelId(aiModel) || model;
    const result = ai.callModel({
      model: targetModel,
      input: [
        {
          role: "system",
          type: "message",
          content: buildSystemMessage(context),
        } as any,
        {
          role: "user",
          type: "message",
          content: [
            {
              type: "input_text",
              text: `Task: Identify the interview question visible on the screen and provide a tailored answer. If the question is technical or asks for logic/coding, ALWAYS include a full code implementation in ${context?.language}.`,
            },
            {
              type: "input_image",
              detail: "auto",
              imageUrl: `data:image/jpeg;base64,${compressed.toString("base64")}`,
            },
          ] as any,
        },
      ],
    });

    return processAIStream(result, session, id, "(question from screenshot)");
  } catch (err: any) {
    console.error("OpenRouter Error (analyzeScreen):", err);
    if (err.status === 429 || err.statusCode === 429) {
      return (async function* () {
        yield {
          text: "AI is temporarily rate-limited. Please wait a moment and try again.",
        };
      })();
    }
    throw err;
  }
}

/**
 * Generates an AI answer based on a transcript and session context.
 * Uses a single AI call — the model returns QUESTION + ANSWER in one response.
 */
export async function getAIAnswer(
  id: string,
  transcript: string,
  isCustomQuery: boolean = false,
  aiModel?: string,
) {
  const session = await prisma.session.findUnique({
    where: { id },
    include: { company: true },
  });

  if (!session) {
    throw new Error("Session not found");
  }

  const context = await getSessionFullContext(id);

  try {
    const targetModel = resolveModelId(aiModel) || model;
    const result = ai.callModel({
      model: targetModel,
      input: [
        {
          role: "system",
          type: "message",
          content: buildSystemMessage(context),
        } as any,
        {
          role: "user",
          type: "message",
          content: isCustomQuery
            ? `Task: Answer the user's specific question directly. If the question involves logic or coding, ALWAYS provide a code implementation in ${context?.language}.\n\nQuestion:\n${transcript}`
            : `Task: Identify the MOST RECENT technical or behavioral question in the transcript and provide an answer. For technical/coding questions, ALWAYS provide a code implementation in ${context?.language}.\n\nTranscript:\n${transcript}`,
        },
      ],
    });

    return processAIStream(
      result,
      session,
      id,
      isCustomQuery ? transcript : transcript.slice(0, 300),
    );
  } catch (err: any) {
    console.error("OpenRouter Streaming Error (getAIAnswer):", err);
    if (err.status === 429 || err.statusCode === 429) {
      return (async function* () {
        yield {
          text: "AI is temporarily rate-limited. Please wait a moment and try again.",
        };
      })();
    }
    throw err;
  }
}

/**
 * Transcribes audio (Placeholder - implementation logic needed or restored).
 */
export async function transcribe(file: Express.Multer.File) {
  // Logic to call transcription service (e.g., Deepgram/Sarvam)
  return { text: "Transcription placeholder (restored)" };
}

/**
 * Appends a message to the session's JSON messages array AND the Transcript table.
 */
export async function appendMessage(
  sessionId: string,
  role: "INTERVIEWER" | "AI_ASSISTANT" | "USER",
  question: string,
  answer: string,
  time?: string,
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { messages: true, transcript: true },
  });

  if (!session) throw new Error("Session not found");

  const currentMessages = Array.isArray(session.messages)
    ? (session.messages as any[])
    : [];

  const currentTranscript = Array.isArray(session.transcript)
    ? (session.transcript as any[])
    : [];

  const newMessage = {
    role,
    question,
    answer,
    timestamp: new Date().toISOString(),
    time,
  };

  const transcriptEntry = {
    role,
    question,
    answer,
    content: answer ? `Q: ${question}\n\nA: ${answer}` : question,
    time:
      time ||
      new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    createdAt: new Date().toISOString(),
  };

  return prisma.session.update({
    where: { id: sessionId },
    data: {
      messages: [...currentMessages, newMessage],
      transcript: [...currentTranscript, transcriptEntry],
    },
  });
}

export async function saveTranscript(
  sessionId: string,
  role: string,
  content: string,
  time?: string,
  question?: string,
  answer?: string,
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { transcript: true },
  });

  if (!session) throw new Error("Session not found");

  const currentTranscript = Array.isArray(session.transcript)
    ? (session.transcript as any[])
    : [];

  const transcriptEntry = {
    role,
    content,
    question,
    answer,
    time:
      time ||
      new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    createdAt: new Date().toISOString(),
  };

  return prisma.session.update({
    where: { id: sessionId },
    data: {
      transcript: [...currentTranscript, transcriptEntry],
    },
  });
}

/**
 * Generates and saves post-session analytics feedback using AI.
 * This analyzes the transcript, QA records, and session context (Resume/JD).
 * @param rawTranscript Optional transcript string provided directly
 */
export async function generateSessionFeedback(
  sessionId: string,
  rawTranscript?: string,
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      questions: { orderBy: { createdAt: "asc" } },
      company: true,
    },
  });

  if (!session) throw new Error("Session not found");

  // Fetch Resume context if available
  let resumeContext = "";
  if (session.resumeId) {
    try {
      const resume = await prisma.resume.findUnique({
        where: { id: session.resumeId },
      });
      resumeContext = resume?.resumeContext || "";
    } catch (e) {
      console.warn("Failed to fetch resume context for analytics:", e);
    }
  }

  // Fetch Document context if available
  let documentContext = "";
  if (session.DocumentId) {
    try {
      const doc = await prisma.document.findUnique({
        where: { id: session.DocumentId },
      });
      if (doc) {
        const ext = path.extname(doc.path).toLowerCase();
        documentContext = await documentService.extractTextFromFile(
          doc.path,
          ext,
        );
      }
    } catch (e) {
      console.warn("Failed to fetch document context for analytics:", e);
    }
  }

  // Use provided rawTranscript or build it from the transcript JSON field
  let formattedTranscript = "";
  if (rawTranscript) {
    formattedTranscript = rawTranscript;
  } else {
    const transcriptArray = Array.isArray(session.transcript)
      ? (session.transcript as any[])
      : [];

    formattedTranscript = transcriptArray
      .map((t) => `[${t.time || t.createdAt}] ${t.role}: ${t.content}`)
      .join("\n");

    // Fallback: If transcripts table is empty, check extraContext
    if (!formattedTranscript && session.extraContext) {
      formattedTranscript = session.extraContext;
    }
  }

  const formattedQA = session.questions
    .map(
      (q, i) =>
        `Q${i + 1}: ${q.ques}\nA${i + 1}: ${q.answer || "No answer provided"}`,
    )
    .join("\n\n");

  const messagesArray = Array.isArray(session.messages)
    ? (session.messages as any[])
    : [];
  const formattedMessages = messagesArray
    .map(
      (m, i) =>
        `Message ${i + 1} (${m.role}) [${m.time || m.timestamp}]:\nQuestion: ${m.question}\nAI Suggested Answer: ${m.answer}`,
    )
    .join("\n\n");

  const prompt = `
    You are an expert technical interviewer and behavioral analyst.
    Analyze the following interview session data and provide a deep "Gap Analysis" feedback.

    ### Session Context:
    - Company: ${session.companyName || session.company?.name || "Unknown"}
    - Target Role: ${session.jobDescription || "Not specified"}
    - Technical Stack: ${session.language || "General"}
    - AI Assists Used: ${session.aiUsage}
    - Candidate Resume Summary: ${resumeContext || "No resume context provided."}
    - Additional Document Content: ${documentContext.substring(0, 5000) || "None"}
    - Language Preference: ${session.simpleLanguage ? "Simple/Plain English" : "Technical/Professional"}
    - Session Mode: ${session.mode}
    - Extra Context provided by user: ${session.extraContext || "None"}

    ### Data Sources:
    1. Transcript (Conversational Flow):
    ${formattedTranscript || "No transcript available."}

    2. Technical QA (Screen Analysis & Problem Solving):
    ${formattedQA || "No specific technical questions recorded."}

    3. Session Messages (AI Assisted Answers & Saved QA):
    ${formattedMessages || "No additional messages recorded."}

    ### Instructions & Evaluation Tasks:
    1. **Question-Answer Gap Analysis**: 
       - Identify every question asked by the interviewer (found in the Transcript or QA/Messages).
       - Compare these questions with the "AI Suggested Answer" provided to the user.
       - Evaluate how well the AI-generated responses matched the technical and professional requirements of the interviewer's questions.
       - **TIME GAP ANALYSIS**: Pay close attention to the time gap between when a question was asked (in the transcript) and when the AI provided the answer (in QA/Messages). Timely responses are critical.
       - **IMPORTANT (Microphone/Transcript Constraint)**: The transcript might only contain the interviewer's voice if the user's microphone was disabled. DO NOT penalize the user or state they "didn't answer properly" or "remained silent" solely based on the absence of user speech in the transcript. Assume the candidate might have answered verbally even if it wasn't captured. Focus your feedback on the quality of the technical exchange and the utility of the AI suggestions.

    2. **Technical Depth**: Evaluate the technical accuracy and relevance of the AI-generated answers in the context of the Job Description and the interviewer's prompts.

    3. **Soft Skills & Interactivity**: Assess the flow of the session. Even if user speech is missing, look for signs of interactivity (e.g., follow-up questions from the interviewer triggered by AI suggestions).

    4. **Improvements with Priority**: For each area of improvement, assign a priority: HIGH, MEDIUM, or LOW. Focus on how the candidate can better leverage AI or improve their own technical depth and response timing.

    ### Output Format:
    You MUST return a JSON object with this exact structure:
    {
      "score": number (0-100),
      "confidence": number (0-100),
      "sessionQuality": "Excellent" | "Good" | "Average" | "Needs Improvement",
      "verdict": "Strong Pass" | "Pass" | "Fail" | "Inconclusive",
      "communication": number (0-100),
      "interactivity": number (0-100),
      "technicalDepth": number (0-100),
      "conciseness": number (0-100),
      "avgResponseLen": number (approx words per answer),
      "answeredCount": number (total questions answered),
      "avgResponseTime": number (approx seconds per answer),
      "strengths": string[],
      "improvements": string[], (Note: Each improvement MUST start with [HIGH], [MEDIUM], or [LOW])
      "interviewerMood": string
    }
  `.trim();

  try {
    const result = ai.callModel({
      model,
      input: [{ role: "user", type: "message", content: prompt }],
      text: {
        format: { type: "json_object" },
      },
    });

    const content = await result.getText();

    if (!content) throw new Error("No content received from AI");

    // Robust JSON extraction (handles markdown blocks if model still provides them)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const feedbackData = JSON.parse(jsonMatch ? jsonMatch[0] : content);

    // Upsert feedback
    return await prisma.sessionFeedback.upsert({
      where: { sessionId },
      create: {
        sessionId,
        score: feedbackData.score || 0,
        confidence: feedbackData.confidence || 0,
        sessionQuality: feedbackData.sessionQuality || "N/A",
        verdict: feedbackData.verdict || "N/A",
        communication: feedbackData.communication || 0,
        interactivity: feedbackData.interactivity || 0,
        technicalDepth: feedbackData.technicalDepth || 0,
        conciseness: feedbackData.conciseness || 0,
        avgResponseLen: feedbackData.avgResponseLen || 0,
        answeredCount: feedbackData.answeredCount || 0,
        aiAssistsCount: session.aiUsage || 0,
        avgResponseTime: feedbackData.avgResponseTime || 0,
        strengths: feedbackData.strengths || [],
        improvements: feedbackData.improvements || [],
        interviewerMood: feedbackData.interviewerMood || "N/A",
      },
      update: {
        score: feedbackData.score || 0,
        confidence: feedbackData.confidence || 0,
        sessionQuality: feedbackData.sessionQuality || "N/A",
        verdict: feedbackData.verdict || "N/A",
        communication: feedbackData.communication || 0,
        interactivity: feedbackData.interactivity || 0,
        technicalDepth: feedbackData.technicalDepth || 0,
        conciseness: feedbackData.conciseness || 0,
        avgResponseLen: feedbackData.avgResponseLen || 0,
        answeredCount: feedbackData.answeredCount || 0,
        aiAssistsCount: session.aiUsage || 0,
        avgResponseTime: feedbackData.avgResponseTime || 0,
        strengths: feedbackData.strengths || [],
        improvements: feedbackData.improvements || [],
        interviewerMood: feedbackData.interviewerMood || "N/A",
      },
    });
  } catch (error) {
    console.error("Error generating session feedback:", error);
    throw new Error("Failed to generate session feedback");
  }
}
