import { prisma } from "../../shared/lib/prisma";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { CreateSessionData } from "./session.types";
import sharp from "sharp";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
const model = "gemini-3-flash-preview";

/**
 * Creates a new interview session.
 */
export async function createSession(data: CreateSessionData) {
  return prisma.session.create({
    data: {
      userId: data.userId,
      company: data.companyName || "",
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
    },
  });
}

/**
 * Returns all sessions for a specific user.
 */
export async function getSessionsByUser(userId: string) {
  return prisma.session.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" }, // Assuming a createdAt field exists, otherwise order by id or remove
  });
}

/**
 * Returns a specific session by ID.
 */
export async function getSessionById(id: string) {
  return prisma.session.findUnique({
    where: { id },
  });
}

/**
 * Deletes a session by ID.
 */
export async function deleteSession(id: string) {
  return prisma.session.delete({
    where: { id },
  });
}

/**
 * Activates a session (sets isActive to true and records start time).
 */
export async function activateSession(id: string) {
  return prisma.session.update({
    where: { id },
    data: {
      isActive: true,
      startedAt: new Date(),
    },
    include: { user: true },
  });
}

/**
 * Deactivates a session (sets isActive to false and records end time).
 */
export async function deactivateSession(id: string) {
  return prisma.session.update({
    where: { id },
    data: {
      isActive: false,
      endedAt: new Date(),
    },
  });
}

/**
 * Analyzes a provided screenshot within a session context.
 */
export async function analyzeScreen(id: string, file: Express.Multer.File) {
  const compressed = await sharp(file.buffer)
    .resize({ width: 800 })
    .jpeg({ quality: 60 })
    .toBuffer();
  console.log("🚀 ~ analyzeScreen ~ compressed:", compressed);
  const session = await prisma.session.findUnique({ where: { id } });

  const config = {
    thinkingConfig: {
      thinkingLevel: ThinkingLevel.HIGH,
    },
  };

  const prompt = `
      You are an expert interview assistant. 
      Analyze the provided screenshot from an active interview session.
      
      Context:
      - Company: ${session?.company || "Unknown"}
      - Role: ${session?.jobDescription || "Interviewee"}
      
      Task:
      Look at the question or content on the screen. 
      Provide a concise, helpful, and professional answer or suggestion to help the user.
      Focus on bullet points if providing a general answer.
      If the question is related to programming or requires writing code, you MUST provide the necessary code implementation along with your explanation.
    `.trim();

  const contents = [
    { text: prompt },
    {
      inlineData: {
        data: compressed.toString("base64"),
        mimeType: "image/jpeg",
      },
    },
  ];
  console.log("🚀 ~ analyzeScreen ~ contents:", contents);

  try {
    const res = await ai.models.generateContentStream({
      model,
      contents,
      config,
    });

    console.log("🚀 ~ analyzeScreen ~ res:", res);

    return res;
  } catch (err) {
    if (err.status === 429) {
      return { text: "AI busy, try again in a moment" };
    }
  }
}

/**
 * Generates an AI answer based on a transcript and session context.
 */
export async function getAIAnswer(id: string, transcript: string) {
  const session = await prisma.session.findUnique({ where: { id } });

  const prompt = `
      You are an AI Interview Assistant. 
      Analyze the provided transcript from an active interview session.
      
      Context:
      - Company: ${session?.company || "Unknown"}
      - Role: ${session?.jobDescription || "Interviewee"}
      
      Task:
      Extract the MOST RECENT question asked by the interviewer in the transcript provided below. 
      Provide a concise, professional answer to help the candidate. 
      If no question is found, provide a helpful suggestion based on context.
      
      Transcript:
      ${transcript}
    `.trim();

  const contents = [{ text: prompt }];

  try {
    const res = await ai.models.generateContentStream({
      model,
      contents,
    });

    return res;
  } catch (err: any) {
    console.error("Gemini Streaming Error (getAIAnswer):", err);
    if (err.status === 429) {
      return { text: "AI busy, try again in a moment" };
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
 * Appends a message to the session's JSON messages array.
 */
export async function appendMessage(
  sessionId: string,
  role: "INTERVIEWER" | "AI_ASSISTANT" | "USER",
  content: string,
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { messages: true },
  });

  if (!session) throw new Error("Session not found");

  const currentMessages = Array.isArray(session.messages)
    ? (session.messages as any[])
    : [];

  const newMessage = {
    role,
    content,
    timestamp: new Date().toISOString(),
  };

  return prisma.session.update({
    where: { id: sessionId },
    data: {
      messages: [...currentMessages, newMessage],
    },
  });
}
