import fs from "fs";
import path from "path";
import { Prisma } from "@prisma/client";
import { OpenRouter } from "@openrouter/sdk";

import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import type {
  SaveBuiltResumeInput,
  GenerateResumeHtmlInput,
  EnhanceSectionInput,
  TailorResumeInput,
  ExportPdfInput,
  ExtractFieldsInput,
  MarkBuiltResumeCompleteInput,
  ResumeFields,
} from "./resume.types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL;
const EXPORTS_DIR = "uploads/exports";

const VALID_SECTION_IDS = [
  "summary",
  "experience",
  "skills",
  "projects",
  "education",
  "certifications",
  "publications",
] as const;

// Credit costs
const COST_GENERATE = new Prisma.Decimal("1");
const COST_ENHANCE = new Prisma.Decimal("0.5");
const COST_TAILOR = new Prisma.Decimal("1");

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY environment variable is not defined");
}

const ai = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// Internal Utilities
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Atomically deducts credits from a user's balance and records a ledger entry.
 * Throws AppError(402) if balance is insufficient.
 */
async function deductCredits(
  userId: string,
  amount: Prisma.Decimal,
  operation: string,
): Promise<{ creditsRemaining: number }> {
  let creditsRemaining = 0;

  await prisma.$transaction(async (tx) => {
    const balance = await tx.userCreditBalance.findUnique({
      where: { userId },
    });

    if (!balance) {
      throw new AppError(
        402,
        `Insufficient credits. Required: ${amount}, Available: 0`,
      );
    }

    const available = new Prisma.Decimal(balance.totalAvailable.toString());
    if (available.lt(amount)) {
      throw new AppError(
        402,
        `Insufficient credits. Required: ${amount}, Available: ${available}`,
      );
    }

    const after = available.minus(amount);

    await tx.userCreditBalance.update({
      where: { userId },
      data: { totalAvailable: after },
    });

    await tx.creditLedger.create({
      data: {
        userId,
        type: "DEBIT",
        amount,
        balanceBefore: available,
        balanceAfter: after,
        reason: operation,
      },
    });

    creditsRemaining = after.toNumber();
  });

  return { creditsRemaining };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD — Built Resume
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new built resume or updates an existing one (upsert by resumeId).
 */
export async function saveBuiltResume(input: SaveBuiltResumeInput) {
  const { userId, resumeId, title, templateId, fields, sections, jobDescription, jobTitle, company } = input;

  if (resumeId) {
    const existing = await prisma.builtResume.findUnique({ where: { id: resumeId } });
    if (!existing) {
      throw new AppError(404, "Resume not found");
    }

    return prisma.builtResume.update({
      where: { id: resumeId },
      data: {
        title,
        templateId,
        fields: fields as unknown as Prisma.InputJsonValue,
        sections: sections as unknown as Prisma.InputJsonValue,
        jobDescription,
        jobTitle,
        company,
      },
    });
  }

  return prisma.builtResume.create({
    data: {
      userId,
      title,
      templateId,
      fields: fields as unknown as Prisma.InputJsonValue,
      sections: sections as unknown as Prisma.InputJsonValue,
      jobDescription,
      jobTitle,
      company,
    },
  });
}

/**
 * Returns all built resumes for a user, ordered newest first (list view — no fields/sections).
 */
export async function listBuiltResumes(userId: string) {
  return prisma.builtResume.findMany({
    where: { userId },
    select: {
      id: true,
      title: true,
      templateId: true,
      jobTitle: true,
      company: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * Returns a single built resume including all fields (used when re-opening the editor).
 */
export async function getBuiltResume(id: string) {
  const resume = await prisma.builtResume.findUnique({ where: { id } });
  if (!resume) {
    throw new AppError(404, "Resume not found");
  }
  return resume;
}

/**
 * Deletes a built resume record.
 */
export async function deleteBuiltResume(id: string): Promise<void> {
  const resume = await prisma.builtResume.findUnique({ where: { id } });
  if (!resume) {
    throw new AppError(404, "Resume not found");
  }
  await prisma.builtResume.delete({ where: { id } });
}

/**
 * Marks a built resume as completed.
 * Sets status to "completed" and records downloadedAt.
 * Only the owner can complete their own resume.
 */
export async function markBuiltResumeComplete(
  input: MarkBuiltResumeCompleteInput,
): Promise<{ id: string; status: string; downloadedAt: Date | null }> {
  const { resumeId, userId } = input;

  const resume = await prisma.builtResume.findUnique({ where: { id: resumeId } });
  if (!resume) {
    throw new AppError(404, "Resume not found");
  }
  if (resume.userId !== userId) {
    throw new AppError(403, "Forbidden");
  }

  const updated = await prisma.builtResume.update({
    where: { id: resumeId },
    data: {
      status: "completed",
      downloadedAt: new Date(),
    },
    select: { id: true, status: true, downloadedAt: true },
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI — Resume Generation (1 credit)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uses AI to populate a resume template's HTML placeholders with the user's
 * fields and optional JD context. Costs 1 credit.
 */
export async function generateResumeHtml(input: GenerateResumeHtmlInput): Promise<{
  populatedHtml: string;
  creditsUsed: number;
  creditsRemaining: number;
}> {
  const { userId, templateCode, fields, jobDescription, jobTitle, company } = input;

  const { creditsRemaining } = await deductCredits(userId, COST_GENERATE, "RESUME_GENERATE");

  const prompt = `
You are a professional resume writer. You have been given an HTML resume template and a set of user data fields.
Your task is to return the complete, populated HTML with all placeholder content replaced by the user's actual data.

Rules:
- Replace all placeholder text in the template with the user's data.
- Do NOT change the HTML structure, CSS classes, or styling in any way.
- If a field is empty, leave its container empty but keep the HTML element.
- For the experience/projects/education sections, format multi-line text blocks into clean HTML list items.
- Output ONLY the complete HTML document with no extra text or markdown.

User fields:
${JSON.stringify(fields, null, 2)}

${jobDescription ? `Target Job: ${jobTitle ?? ""} at ${company ?? ""}\nJob Description: ${jobDescription.substring(0, 1000)}` : ""}

HTML Template:
${templateCode}
  `.trim();

  const response = await ai.chat.send({
    chatRequest: {
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
    },
  });

  const populatedHtml = response.choices[0]?.message?.content?.trim() ?? "";

  return {
    populatedHtml,
    creditsUsed: COST_GENERATE.toNumber(),
    creditsRemaining,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI — Enhance Section (0.5 credits)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AI-rewrites a single resume section to be more impactful.
 * Costs 0.5 credits.
 */
export async function enhanceSection(input: EnhanceSectionInput): Promise<{
  sectionId: string;
  enhancedText: string;
  creditsUsed: number;
  creditsRemaining: number;
}> {
  const { userId, sectionId, currentText, jobDescription, jobTitle, resumeContext } = input;

  if (!(VALID_SECTION_IDS as readonly string[]).includes(sectionId)) {
    throw new AppError(400, "Invalid sectionId");
  }

  const { creditsRemaining } = await deductCredits(userId, COST_ENHANCE, "RESUME_ENHANCE_SECTION");

  const prompt = `
You are an expert resume writer. Rewrite the following resume section to be more impactful, quantified, and ATS-friendly.

Section: ${sectionId}
${resumeContext ? `Full resume context: ${resumeContext.substring(0, 1000)}` : ""}
${jobDescription ? `Target role: ${jobTitle ?? ""}\nJob description: ${jobDescription.substring(0, 800)}` : ""}

Current text:
${currentText}

Instructions:
- Use strong action verbs.
- Add quantified impact where possible (e.g. "reduced load time by 40%").
- Keep the same format (plain text, not HTML).
- Return ONLY the rewritten section text with no explanation.
  `.trim();

  const response = await ai.chat.send({
    chatRequest: {
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
    },
  });

  const enhancedText = response.choices[0]?.message?.content?.trim() ?? currentText;

  return {
    sectionId,
    enhancedText,
    creditsUsed: COST_ENHANCE.toNumber(),
    creditsRemaining,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI — Tailor Resume (1 credit)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AI-tailors all relevant resume sections to a target job description.
 * Costs 1 credit.
 */
export async function tailorResume(input: TailorResumeInput): Promise<{
  tailoredFields: Partial<ResumeFields>;
  keywordsMatched: string[];
  keywordsMissing: string[];
  matchScore: number;
  creditsUsed: number;
  creditsRemaining: number;
}> {
  const { userId, resumeId, jobDescription, jobTitle, company } = input;

  const resume = await prisma.builtResume.findUnique({ where: { id: resumeId } });
  if (!resume) {
    throw new AppError(404, "Resume not found");
  }

  const { creditsRemaining } = await deductCredits(userId, COST_TAILOR, "RESUME_TAILOR");

  const currentFields = resume.fields as unknown as ResumeFields;

  const prompt = `
You are an expert resume writer and ATS optimization specialist.
Tailor the provided resume to the target job description by rewriting relevant sections.

Target Job: ${jobTitle ?? "Not specified"} at ${company ?? "Not specified"}
Job Description:
${jobDescription.substring(0, 1500)}

Current Resume Fields:
${JSON.stringify(
  {
    summary: currentFields.summary,
    experience: currentFields.experience,
    skillsLanguages: currentFields.skillsLanguages,
    skillsFrameworks: currentFields.skillsFrameworks,
    skillsDatabases: currentFields.skillsDatabases,
    skillsTools: currentFields.skillsTools,
    projects: currentFields.projects,
  },
  null,
  2,
)}

Return a JSON object with this exact shape (no extra text, no markdown):
{
  "tailoredFields": {
    "summary": "...",
    "experience": "...",
    "skillsLanguages": "...",
    "skillsFrameworks": "...",
    "skillsDatabases": "...",
    "skillsTools": "...",
    "projects": "..."
  },
  "keywordsMatched": ["keyword1", "keyword2"],
  "keywordsMissing": ["keyword3"],
  "matchScore": 82
}
  `.trim();

  const response = await ai.chat.send({
    chatRequest: {
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
    },
  });

  const aiText = response.choices[0]?.message?.content ?? "";
  const parsed = parseJsonResponse<{
    tailoredFields: Partial<ResumeFields>;
    keywordsMatched: string[];
    keywordsMissing: string[];
    matchScore: number;
  }>(aiText);

  if (!parsed) {
    throw new AppError(500, "AI returned an unparseable response");
  }

  return {
    tailoredFields: parsed.tailoredFields ?? {},
    keywordsMatched: parsed.keywordsMatched ?? [],
    keywordsMissing: parsed.keywordsMissing ?? [],
    matchScore: parsed.matchScore ?? 0,
    creditsUsed: COST_TAILOR.toNumber(),
    creditsRemaining,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export PDF (saves HTML to disk, returns served URL)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Saves the populated resume HTML to disk and returns a static download URL.
 * Requires either a resumeId (fetches from DB) or a populatedHtml string.
 * The file expires 24 hours after creation.
 */
export async function exportResumeHtml(input: ExportPdfInput): Promise<{
  downloadUrl: string;
  expiresAt: string;
}> {
  let html: string;

  if (input.populatedHtml) {
    html = input.populatedHtml;
  } else if (input.resumeId) {
    const resume = await prisma.builtResume.findUnique({ where: { id: input.resumeId } });
    if (!resume) {
      throw new AppError(404, "Resume not found");
    }
    // Return fields as JSON payload — actual rendering is client-side
    html = `<html><body><pre>${JSON.stringify(resume.fields, null, 2)}</pre></body></html>`;
  } else {
    throw new AppError(400, "resumeId or populatedHtml is required");
  }

  if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  }

  const filename = `resume_export_${Date.now()}.html`;
  const filePath = path.join(EXPORTS_DIR, filename);
  fs.writeFileSync(filePath, html, "utf-8");

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  return {
    downloadUrl: `/uploads/exports/${filename}`,
    expiresAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI — Extract & Structure Resume Fields (0.5 credits)
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_RESUME_FIELDS: ResumeFields = {
  name: "", role: "", email: "", phone: "", location: "", links: "",
  summary: "", experience: "", skillsLanguages: "", skillsFrameworks: "",
  skillsDatabases: "", skillsTools: "", projects: "", education: "",
  certifications: "", publications: "",
};

/**
 * Uses AI to parse raw resume text into structured ResumeFields.
 * Optionally tailors the content toward a target job description.
 * Costs 0.5 credits.
 */
export async function extractFields(input: ExtractFieldsInput): Promise<{
  fields: ResumeFields;
  creditsUsed: number;
  creditsRemaining: number;
}> {
  const { userId, resumeContext, jobDescription, jobTitle, company } = input;

  const COST = new Prisma.Decimal("0.5");
  const { creditsRemaining } = await deductCredits(userId, COST, "RESUME_EXTRACT_FIELDS");

  const prompt = `You are an expert resume parser. Extract and structure all data from the resume text below.

Return ONLY a valid JSON object with EXACTLY this structure (all values must be strings):
{
  "name": "candidate full name",
  "role": "current or most recent job title",
  "email": "email address",
  "phone": "phone number",
  "location": "city, country or full address",
  "links": "LinkedIn, GitHub, portfolio URLs separated by  |  ",
  "summary": "3-4 sentence professional summary${jobTitle ? ` tailored for ${jobTitle} role` : ""}",
  "experience": "work experience blocks separated by double newline. Each block: Company | Title | Start–End\\n• bullet 1\\n• bullet 2",
  "skillsLanguages": "comma-separated programming languages",
  "skillsFrameworks": "comma-separated frameworks and libraries",
  "skillsDatabases": "comma-separated databases and data stores",
  "skillsTools": "comma-separated tools, cloud platforms, and other skills",
  "projects": "project blocks separated by double newline. Each block: Project Title\\n• bullet 1\\n• bullet 2",
  "education": "education blocks separated by double newline. Each block: Degree\\nInstitution\\nYear",
  "certifications": "certifications as newline-separated list",
  "publications": "publications as newline-separated list"
}

${jobDescription ? `Target Job: ${jobTitle ?? ""} at ${company ?? ""}\nJob Description (tailor content toward this role): ${jobDescription.substring(0, 800)}\n` : ""}
Resume Text:
${resumeContext.substring(0, 5000)}

Return ONLY the JSON object. No explanation, no markdown code fences.`.trim();

  const response = await ai.chat.send({
    chatRequest: {
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
    },
  });

  const content = response.choices[0]?.message?.content?.trim() ?? "";
  const parsed = parseJsonResponse<Partial<ResumeFields>>(content);
  const fields: ResumeFields = { ...EMPTY_RESUME_FIELDS, ...(parsed ?? {}) };

  return {
    fields,
    creditsUsed: COST.toNumber(),
    creditsRemaining,
  };
}
