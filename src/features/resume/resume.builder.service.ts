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
  ValidateSectionInput,
  SectionValidationResult,
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
 * Also resolves the human-readable template name from ResumeTemplate.
 */
export async function listBuiltResumes(userId: string) {
  const resumes = await prisma.builtResume.findMany({
    where: { userId },
    select: {
      id: true,
      title: true,
      templateId: true,
      jobTitle: true,
      company: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  // Resolve template names in a single query to avoid N+1
  const templateIds = [...new Set(resumes.map((r) => r.templateId).filter(Boolean))];
  const templates   = await prisma.resumeTemplate.findMany({
    where: { id: { in: templateIds } },
    select: { id: true, name: true },
  });
  const templateMap = new Map(templates.map((t) => [t.id, t.name]));

  return resumes.map((r) => ({
    ...r,
    templateName: templateMap.get(r.templateId) ?? r.templateId ?? null,
  }));
}

/**
 * Returns a single built resume including all fields (used when re-opening the editor).
 * Also resolves templateCode from ResumeTemplate so the editor has the HTML immediately.
 */
export async function getBuiltResume(id: string) {
  const resume = await prisma.builtResume.findUnique({ where: { id } });
  if (!resume) {
    throw new AppError(404, "Resume not found");
  }

  // Resolve template HTML — templateId is either a UUID (from DB) or a slug
  // like "classic" / "modern" / "minimal" (from the hardcoded fallback).
  let templateCode: string | null = null;
  if (resume.templateId) {
    const byId = await prisma.resumeTemplate.findUnique({ where: { id: resume.templateId } });
    if (byId) {
      templateCode = byId.code;
    } else {
      // Slug match: "classic" → name "Classic"
      const slug = resume.templateId.charAt(0).toUpperCase() + resume.templateId.slice(1).toLowerCase();
      const byName = await prisma.resumeTemplate.findFirst({ where: { name: slug } });
      if (byName) templateCode = byName.code;
    }
  }

  return { ...resume, templateCode };
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
// AI — Validate Section Quality (free, no credits)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AI-evaluates a single resume section and returns a quality score (0–100),
 * specific issues, actionable suggestions, and dynamically-determined
 * min/max word/bullet constraints appropriate for the candidate's seniority
 * and target role.  No credits are consumed.
 */
export async function validateSection(
  input: ValidateSectionInput,
): Promise<SectionValidationResult> {
  const { sectionId, currentText, jobTitle, company, resumeContext } = input;

  if (!(VALID_SECTION_IDS as readonly string[]).includes(sectionId)) {
    throw new AppError(400, "Invalid sectionId");
  }

  const wordCount = currentText.trim() === ""
    ? 0
    : currentText.trim().split(/\s+/).filter(Boolean).length;

  const prompt = `
You are an expert resume quality evaluator. Analyse this resume section and return a strict JSON object — no markdown, no extra text.

Section: ${sectionId}
${resumeContext ? `Candidate context: ${resumeContext}` : ""}
${jobTitle ? `Target role: ${jobTitle}${company ? ` at ${company}` : ""}` : ""}

Current content (${wordCount} words):
${currentText.substring(0, 2000)}

Return ONLY valid JSON matching this exact schema:
{
  "score": <integer 0–100>,
  "status": <"excellent" | "good" | "needs_improvement" | "poor">,
  "issues": [<up to 4 short strings, max 90 chars each — concrete problems found>],
  "suggestions": [<up to 3 short actionable strings, max 110 chars each>],
  "constraints": {
    "minWords": <integer — ideal minimum word count for this section given the candidate's seniority/role>,
    "maxWords": <integer — ideal maximum word count>,
    "minBullets": <integer or null — minimum bullet points if bullets apply, else null>,
    "maxBullets": <integer or null — maximum bullet points if bullets apply, else null>,
    "reason": <one concise sentence explaining why these constraints fit this role/section>
  }
}

Scoring rubric:
90–100 Excellent  — quantified, action-verb-led, ATS-optimised, perfect length for the role
70–89  Good       — solid but minor improvements possible
40–69  Needs work — missing quantification, too brief/long, weak verbs, or generic phrasing
0–39   Poor       — very thin, placeholder-like, or completely wrong content for the section
`.trim();

  const response = await ai.chat.send({
    chatRequest: {
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
    },
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
  const parsed = parseJsonResponse<Record<string, unknown>>(raw);

  // Sensible fallback defaults so the UI always has something to render
  const DEFAULTS: SectionValidationResult = {
    score: 50,
    status: "needs_improvement",
    issues: [],
    suggestions: [],
    constraints: {
      minWords: 30,
      maxWords: 300,
      minBullets: null,
      maxBullets: null,
      reason: "Standard resume section length guidelines.",
    },
    wordCount,
  };

  if (!parsed) return DEFAULTS;

  const rawConstraints = (parsed.constraints as Record<string, unknown>) ?? {};

  const score = Math.min(100, Math.max(0, Number(parsed.score) || 50));
  const statusOptions = ["excellent", "good", "needs_improvement", "poor"] as const;
  const status = statusOptions.includes(parsed.status as typeof statusOptions[number])
    ? (parsed.status as typeof statusOptions[number])
    : score >= 90 ? "excellent"
    : score >= 70 ? "good"
    : score >= 40 ? "needs_improvement"
    : "poor";

  return {
    score,
    status,
    issues: Array.isArray(parsed.issues)
      ? (parsed.issues as string[]).slice(0, 4)
      : [],
    suggestions: Array.isArray(parsed.suggestions)
      ? (parsed.suggestions as string[]).slice(0, 3)
      : [],
    constraints: {
      minWords: Number(rawConstraints.minWords) || DEFAULTS.constraints.minWords,
      maxWords: Number(rawConstraints.maxWords) || DEFAULTS.constraints.maxWords,
      minBullets: rawConstraints.minBullets != null ? Number(rawConstraints.minBullets) : null,
      maxBullets: rawConstraints.maxBullets != null ? Number(rawConstraints.maxBullets) : null,
      reason: typeof rawConstraints.reason === "string"
        ? rawConstraints.reason
        : DEFAULTS.constraints.reason,
    },
    wordCount,
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
