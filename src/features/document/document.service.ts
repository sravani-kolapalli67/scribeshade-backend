import path from "path";
import fs from "fs";
import { OpenRouter } from "@openrouter/sdk";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

import { prisma } from "../../shared/lib/prisma";
import {
  DocumentAnalysisResult,
  CreateDocumentRequest,
} from "./document.types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const UPLOAD_DIR = "uploads/documents";
export const ALLOWED_EXTENSIONS = [".pdf", ".doc", ".docx", ".txt"];

const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-exp:free";

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY environment variable is not defined");
}

const ai = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  httpReferer: "https://scribeshade.com",
  appTitle: "ScribeShade",
});

// Internal Utilities

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

// Exported Service Functions

/**
 * Extracts plain text from a PDF, DOCX, or TXT file.
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

  if (ext === ".txt") {
    return fileBuffer.toString("utf8");
  }

  return "";
}

/**
 * Persists a newly uploaded document record.
 */
export async function createDocumentRecord(data: CreateDocumentRequest) {
  return prisma.document.create({
    data: {
      filename: data.filename,
      path: data.filePath,
      size: data.size,
      userId: data.userId,
    },
  });
}

/**
 * Returns all documents for a given user.
 */
export async function getDocumentsByUser(userId: string) {
  return prisma.document.findMany({
    where: { userId },
    orderBy: { uploadedAt: "desc" },
  });
}

/**
 * Deletes a document record and its file.
 */
export async function deleteDocument(id: string): Promise<void> {
  const doc = await prisma.document.findUnique({ where: { id } });

  if (!doc) {
    throw Object.assign(new Error("Document not found"), { statusCode: 404 });
  }

  try {
    if (fs.existsSync(doc.path)) fs.unlinkSync(doc.path);
  } catch {
    // Silent cleanup
  }

  await prisma.document.delete({ where: { id } });
}

/**
 * Analyzes a document using Gemini to provide a summary and key points.
 */
export async function analyzeDocument(
  documentId: string,
): Promise<DocumentAnalysisResult> {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });

  if (!doc) {
    throw Object.assign(new Error("Document not found"), {
      statusCode: 404,
    });
  }

  // Read content from disk since it's no longer in the DB
  const ext = path.extname(doc.path).toLowerCase();
  const content = await extractTextFromFile(doc.path, ext);

  if (!content || !content.trim()) {
    throw new Error("Failed to extract content from document file");
  }

  const prompt = `
You are a document analyst. Analyze the provided text and respond with ONLY a valid JSON object:

{
  "summary": "A concise summary of the document",
  "keyPoints": ["Point 1", "Point 2", "..."],
  "extraction": {
    "topics": ["topic1", "topic2"],
    "entities": ["entity1", "entity2"]
  }
}

Text to analyze:
${content.substring(0, 10_000)}
  `.trim();

  const response = await ai.chat.send({
    chatRequest: {
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
    },
  });

  const text = response.choices[0]?.message?.content || "";
  const parsed = parseJsonResponse<DocumentAnalysisResult>(text);
  if (!parsed) {
    throw new Error("Failed to parse analysis result from AI");
  }

  return parsed;
}
