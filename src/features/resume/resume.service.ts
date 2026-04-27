import path from "path";
import fs from "fs";

import { OpenRouter } from "@openrouter/sdk";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

import { prisma } from "../../shared/lib/prisma";
import {
  AtsAnalysisResult,
  CoverLetterRequest,
  CreateTemplateRequest,
} from "./resume.types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const UPLOAD_DIR = "uploads/resumes";
export const ALLOWED_EXTENSIONS = [".pdf", ".doc", ".docx"];

const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL;

// OpenRouter AI Client

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY environment variable is not defined");
}

const ai = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  //   httpReferer: "https://scribeshade.com",
  //   appTitle: "ScribeShade",
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal Utilities (not exported — used only within this service)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses a JSON response string from Gemini.
 * Falls back to a regex extraction if the model wraps the JSON in prose/markdown.
 */
function parseJsonResponse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// uploadAndWaitForGeminiFile removed - no longer needed with OpenRouter

// ─────────────────────────────────────────────────────────────────────────────
// Exported Service Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts plain text from a PDF or DOCX/DOC file.
 */
export async function extractTextFromFile(
  filePath: string,
  ext: string,
): Promise<string> {
  const fileBuffer = fs.readFileSync(filePath);

  if (ext === ".pdf") {
    const parsed = await new PDFParse({ url: filePath });
    const result = await parsed.getText();
    return result.text;
  }

  if (ext === ".docx" || ext === ".doc") {
    const parsed = await mammoth.extractRawText({ buffer: fileBuffer });
    return parsed.value;
  }

  return "";
}

/**
 * Asks Gemini to classify whether the given text is a resume/CV.
 */
export async function validateIsResume(text: string): Promise<boolean> {
  const prompt = `
You are a document classifier. Analyze the following text and determine if it is a resume/CV.

A resume/CV typically contains:
- Personal information (name, contact details)
- Work experience or employment history
- Education or qualifications
- Skills or competencies

Respond with ONLY a valid JSON object — no extra text:
{"isResume": true} or {"isResume": false}

Text to analyze:
${text.substring(0, 3_000)}
  `.trim();

  const response = await ai.chat.send({
    chatRequest: {
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
    },
  });

  const aiText = response.choices[0]?.message?.content || "";
  const parsed = parseJsonResponse<{ isResume: boolean }>(aiText);
  return parsed?.isResume === true;
}

/**
 * Persists a newly uploaded resume file to the database.
 */
export async function createResumeRecord(data: {
  filename: string;
  filePath: string;
  size: number;
  resumeContext: string;
  userId: string;
}) {
  return prisma.resume.create({
    data: {
      filename: data.filename,
      path: data.filePath,
      size: data.size,
      resumeContext: data.resumeContext,
      userId: data.userId,
    },
  });
}

/**
 * Returns all resumes for a given user, ordered newest first.
 */
export async function getResumesByUser(userId: string) {
  return prisma.resume.findMany({
    where: { userId },
    orderBy: { uploadedAt: "desc" },
  });
}

/**
 * Returns all ATS-analysed resumes (with their analysis) for a given user.
 */
export async function getAtsResumesByUser(userId: string) {
  return prisma.resume.findMany({
    where: { userId, ats: true },
    include: { atsAnalysis: true },
    orderBy: { uploadedAt: "desc" },
  });
}

/**
 * Runs an ATS analysis via Gemini on an existing resume, persisting the result
 * to the database and flagging the resume as analysed.
 *
 * Returns the parsed ATS result.
 */
export async function runAtsAnalysis(
  resumeId: string,
): Promise<AtsAnalysisResult> {
  const resume = await prisma.resume.findUnique({ where: { id: resumeId } });

  if (!resume) {
    throw Object.assign(new Error("Resume not found"), { statusCode: 404 });
  }

  const absolutePath = path.resolve(resume.path);
  if (!fs.existsSync(absolutePath)) {
    throw Object.assign(new Error("Resume file not found on disk"), {
      statusCode: 404,
    });
  }

  const ext = path.extname(resume.path).toLowerCase();
  const resumeText = await extractTextFromFile(resume.path, ext);

  const prompt = `
You are an ATS (Applicant Tracking System) expert.

Analyze this resume and respond with ONLY a strict JSON object in this exact format:

{
  "score": <number 0-100>,
  "summary": "<short summary string>",
  "strengths": ["<point>", "..."],
  "weaknesses": ["<point>", "..."],
  "missingKeywords": ["<keyword>", "..."],
  "suggestions": ["<improvement>", "..."]
}

Rules:
- Score realistically as a real ATS system would
- Return ONLY the JSON — no markdown, no extra text
  `.trim();

  const response = await ai.chat.send({
    chatRequest: {
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: "system",
          content: "You are an ATS (Applicant Tracking System) expert.",
        },
        {
          role: "user",
          content: `${prompt}\n\nRESUME CONTENT:\n${resumeText}`,
        },
      ],
    },
  });

  const aiText = response.choices[0]?.message?.content || "";
  const parsed = parseJsonResponse<AtsAnalysisResult>(aiText);
  if (!parsed) {
    throw new Error("Failed to parse ATS response from AI");
  }

  await prisma.aTSAnalysis.upsert({
    where: { resumeId },
    update: {
      score: parsed.score,
      summary: parsed.summary,
      strengths: parsed.strengths,
      weaknesses: parsed.weaknesses,
      missingKeywords: parsed.missingKeywords,
      suggestions: parsed.suggestions,
    },
    create: {
      resumeId,
      score: parsed.score,
      summary: parsed.summary,
      strengths: parsed.strengths,
      weaknesses: parsed.weaknesses,
      missingKeywords: parsed.missingKeywords,
      suggestions: parsed.suggestions,
    },
  });

  await prisma.resume.update({ where: { id: resumeId }, data: { ats: true } });

  return parsed;
}

/**
 * Generates a cover letter for a given resume using Gemini.
 */
export async function generateCoverLetter(
  params: CoverLetterRequest,
): Promise<string> {
  const { resumeId, jobRole, company, jobDescription, tone } = params;

  const resume = await prisma.resume.findUnique({ where: { id: resumeId } });

  if (!resume) {
    throw Object.assign(new Error("Resume not found"), { statusCode: 404 });
  }

  const ext = path.extname(resume.path).toLowerCase();
  const resumeText = await extractTextFromFile(resume.path, ext);

  const prompt = `
Generate a ${tone ?? "professional"} cover letter.

Job Role: ${jobRole ?? "Not specified"}
Company: ${company ?? "Not specified"}

Job Description:
${jobDescription ?? "Not provided"}

Instructions:
- Use the provided resume content to tailor the letter
- Keep it between 100 and 250 words
- Write naturally — avoid corporate clichés
- Do NOT include a subject line or email headers
  `.trim();

  const finalPrompt = `${prompt}\n\nRESUME CONTENT:\n${resumeText}`;

  const response = await ai.chat.send({
    chatRequest: {
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: finalPrompt }],
    },
  });

  return response.choices[0]?.message?.content || "";
}

/**
 * Creates a new resume template record.
 */
export async function createTemplate(data: CreateTemplateRequest) {
  return prisma.resumeTemplate.create({ data });
}

/**
 * Returns all stored resume templates.
 */
export async function getAllTemplates() {
  return prisma.resumeTemplate.findMany();
}

/**
 * Deletes a resume record and its associated file from disk.
 * DB cascade handles the ATSAnalysis deletion.
 */
export async function deleteResume(id: string): Promise<void> {
  const resume = await prisma.resume.findUnique({ where: { id } });

  if (!resume) {
    throw Object.assign(new Error("Resume not found"), { statusCode: 404 });
  }

  // Best-effort file cleanup
  try {
    if (fs.existsSync(resume.path)) fs.unlinkSync(resume.path);
  } catch {
    // Intentionally silent
  }

  await prisma.resume.delete({ where: { id } });
}
