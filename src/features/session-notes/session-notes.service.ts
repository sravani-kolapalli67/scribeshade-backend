import { prisma } from "../../shared/lib/prisma";
import { OpenRouter } from "@openrouter/sdk";
import { AppError } from "../../shared/middleware/error.middleware";
import {
  SESSION_NOTES_SYSTEM_PROMPT,
  buildSessionNotesUserPrompt,
} from "../../shared/prompts/session-notes";

const ai = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY || "",
  httpReferer: "https://scribeshade.com",
  appTitle: "ScribeShade",
});

const model = process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";

/**
 * Generates and stores notes/summary for a session.
 */
export async function generateSessionNotes(sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      questions: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!session) throw new AppError(404, "Session not found");

  // Build transcript text from transcript JSON
  const transcriptArray = Array.isArray(session.transcript)
    ? (session.transcript as any[])
    : [];

  const formattedTranscript = transcriptArray
    .map((t) => `[${t.time || t.createdAt}] ${t.role}: ${t.content}`)
    .join("\n");

  const userPrompt = buildSessionNotesUserPrompt({
    company: session.companyName,
    role: session.jobDescription,
    transcript: formattedTranscript,
  });

  try {
    const result = ai.callModel({
      model,
      input: [
        { role: "system", type: "message", content: SESSION_NOTES_SYSTEM_PROMPT },
        { role: "user", type: "message", content: userPrompt },
      ],
      text: {
        format: { type: "json_object" },
      },
    });

    const content = await result.getText();
    if (!content) throw new Error("No content received from AI");

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const notesData = JSON.parse(jsonMatch ? jsonMatch[0] : content);

    // Also include questions from the QA table if any were missed by the AI but recorded during the session
    const qaQuestions = session.questions.map((q) => q.ques);
    const allQuestions = Array.from(new Set([...(notesData.questions || []), ...qaQuestions]));

    return await prisma.sessionNotes.upsert({
      where: { sessionId },
      create: {
        sessionId,
        companyName: session.companyName,
        jobDescription: session.jobDescription,
        summary: notesData.summary || "",
        questions: allQuestions,
      },
      update: {
        companyName: session.companyName,
        jobDescription: session.jobDescription,
        summary: notesData.summary || "",
        questions: allQuestions,
      },
    });
  } catch (error) {
    console.error("Error generating session notes:", error);
    throw new AppError(500, "Failed to generate session notes");
  }
}

/**
 * Retrieves notes for a specific session.
 */
export async function getSessionNotes(sessionId: string) {
  const notes = await prisma.sessionNotes.findUnique({
    where: { sessionId },
  });

  if (!notes) throw new AppError(404, "Notes not found for this session");

  return notes;
}
