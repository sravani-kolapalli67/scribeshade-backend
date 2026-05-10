import fs from "fs";
import path from "path";
import { Prisma } from "@prisma/client";
import { OpenRouter } from "@openrouter/sdk";
import { chromium, type Browser } from "playwright";

import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import {
  withCreditedAiAction,
  getFeatureCost,
  hashInput,
} from "../credits/ai-credit-meter.service";
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
// Absolute path — safe across Docker, PM2, and any working-directory variation.
const EXPORTS_DIR = path.resolve(process.cwd(), "uploads/exports");

const VALID_SECTION_IDS = [
  "summary",
  "experience",
  "skills",
  "projects",
  "education",
  "certifications",
  "publications",
] as const;

// ── Feature keys (single source of truth — also used by Plan.md sync seed) ────
export const RESUME_FEATURE_KEYS = {
  GENERATE: "resume_generate",
  ENHANCE: "resume_enhance_section",
  TAILOR: "resume_tailor",
  EXTRACT: "resume_extract_fields",
} as const;

// Defaults if FeatureCost row is missing (matches Plan.md):
//   parse uploaded resume    → 2
//   section edit (AI enhance) → 1
//   JD tailoring (first-time) → 4 (regen is free via cache)
//   template apply           → 1
const DEFAULT_COST_GENERATE = new Prisma.Decimal("1");
const DEFAULT_COST_ENHANCE = new Prisma.Decimal("1");
const DEFAULT_COST_TAILOR = new Prisma.Decimal("4");
const DEFAULT_COST_EXTRACT = new Prisma.Decimal("2");

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY environment variable is not defined");
}

const ai = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// PDF Browser Singleton
// ─────────────────────────────────────────────────────────────────────────────
//
// Re-using a single Chromium process across exports is the #1 performance lever:
// - browser startup (~300–800ms) is paid once, not per-request
// - pages are cheap (~5ms) and isolated per export
// - the disconnected event auto-nulls the handle so the next request restarts
//
// The singleton is intentionally module-level (not class-based) to keep the
// API surface minimal. A health check ensures stale/crashed browsers are
// evicted before handing the instance to callers.

/** Chromium launch flags optimised for headless server / container usage. */
const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--hide-scrollbars",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-first-run",
  "--safebrowsing-disable-auto-update",
  "--font-render-hinting=none",
];

let _browser: Browser | null = null;
let _browserLaunching = false;

/**
 * Returns the shared Chromium instance, launching it if it hasn't started or
 * has crashed. Uses a lightweight health-check (open + close a context) rather
 * than trusting `browser.isConnected()` alone to catch zombie processes.
 */
async function getSharedBrowser(): Promise<Browser> {
  // Happy path — browser is alive and healthy
  if (_browser?.isConnected()) {
    try {
      const probe = await _browser.newContext();
      await probe.close();
      return _browser;
    } catch {
      // Health check failed — fall through to restart
      _browser = null;
    }
  }

  // Prevent thundering-herd if multiple concurrent export requests arrive
  // while the browser is starting up (e.g. cold start under load).
  if (_browserLaunching) {
    const deadline = Date.now() + 15_000;
    while (_browserLaunching && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (_browser?.isConnected()) return _browser;
  }

  _browserLaunching = true;
  try {
    console.info("[PDF] Launching shared Chromium browser…");
    const t0 = Date.now();
    _browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
    console.info(`[PDF] Browser ready in ${Date.now() - t0}ms`);

    // Auto-null on crash so the next request restarts cleanly.
    _browser.on("disconnected", () => {
      console.warn("[PDF] Chromium disconnected — will restart on next export");
      _browser = null;
    });

    return _browser;
  } finally {
    _browserLaunching = false;
  }
}

// Graceful shutdown — close browser when the Node process exits.
const _shutdownBrowser = () => { _browser?.close().catch(() => {}); };
process.once("exit",    _shutdownBrowser);
process.once("SIGTERM", _shutdownBrowser);
process.once("SIGINT",  _shutdownBrowser);

/**
 * Pre-warm the shared Chromium instance at server startup so the first export
 * request doesn't pay the ~4-5 s cold-start cost and hit the budget timeout.
 */
export async function warmBrowser(): Promise<void> {
  try {
    await getSharedBrowser();
    console.info("[PDF] Browser pre-warmed and ready");
  } catch (err) {
    // Non-fatal — the export handler will retry the launch on demand.
    console.warn(`[PDF] Browser pre-warm failed (will retry on first export): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF Export — Typed Errors
// ─────────────────────────────────────────────────────────────────────────────

/** Fine-grained error codes so the controller can return the right HTTP status
 *  and the frontend can surface a context-appropriate retry message. */
export const PDF_ERROR_CODES = {
  TEMPLATE_RENDER_ERROR: "TEMPLATE_RENDER_ERROR",
  PDF_TIMEOUT:           "PDF_TIMEOUT",
  BROWSER_CRASH:         "BROWSER_CRASH",
  EXPORT_FAILED:         "EXPORT_FAILED",
} as const;

export type PdfErrorCode = (typeof PDF_ERROR_CODES)[keyof typeof PDF_ERROR_CODES];

export class PdfExportError extends AppError {
  readonly code: PdfErrorCode;
  constructor(code: PdfErrorCode, message: string) {
    super(500, message);
    this.code  = code;
    this.name  = "PdfExportError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF Export — Print-Stabilisation CSS
// ─────────────────────────────────────────────────────────────────────────────
//
// Injected into every page after setContent().  Goals:
//   1. Disable all CSS animations/transitions so the PDF snapshot is static.
//   2. Force exact colour printing (-webkit-print-color-adjust).
//   3. Remove Google Fonts @import calls that survive request blocking.
//   4. Override box-shadow with a cheaper equivalent for ATS compatibility.

const PDF_PRINT_CSS = `
  /* ── Animation freeze ── */
  *, *::before, *::after {
    animation-duration:   0ms !important;
    animation-delay:      0ms !important;
    transition-duration:  0ms !important;
    transition-delay:     0ms !important;
  }

  /* ── Exact colour reproduction ── */
  * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust:         exact !important;
  }

  /* ── Do NOT override body font-family — templates declare their own fonts
     (Segoe UI / Georgia / etc.) in inline <style> blocks. Forcing a fallback
     here causes visual mismatch on serif templates (Minimal/Formal) by
     converting them from Georgia → Helvetica. The preview iframe uses
     sandbox="" which also blocks external requests, so both paths render
     identically with the template's own font stack. ── */

  /* ── ATS-friendly: remove large decorative shadows ── */
  * {
    text-shadow: none !important;
  }

  /* ── Remove browser-added page margins ── */
  @page {
    margin: 0 !important;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PAGINATION — Safe page-break system
     Applied universally across all templates via semantic element targeting.
     These rules prevent the three most common resume PDF defects:
       1. Orphan section headings (h2/h3 alone at bottom of page)
       2. Mid-entry splits (bullet list cut between pages)
       3. Large blank gaps from premature forced page breaks
     ═══════════════════════════════════════════════════════════════════════════ */

  /* ── Section containers: never break inside, keep heading + first item ── */
  section,
  .section,
  [data-section] {
    break-inside:      avoid;
    page-break-inside: avoid;
  }

  /* ── Headings: keep with next sibling (at least first content block) ── */
  h1, h2, h3, h4, h5, h6,
  .section-title,
  .section-header {
    break-after:      avoid;
    page-break-after: avoid;
    orphans: 2;
    widows:  2;
  }

  /* ── Individual content blocks: treat each as an atomic unit.
     Experience entries, project cards, education rows, certification items,
     skill groups — all use a consistent set of class names across templates.
     We also target generic list items and common data-* wrappers. ── */
  .exp-item,
  .experience-item,
  .experience-entry,
  .proj-item,
  .project-item,
  .project-card,
  .edu-item,
  .education-item,
  .cert-item,
  .certification-item,
  .skill-group,
  .skills-row,
  /* data-list children rendered by populateTemplate */
  [data-list] > *,
  /* generic list items that hold multi-line content */
  li {
    break-inside:      avoid;
    page-break-inside: avoid;
    orphans: 2;
    widows:  2;
  }

  /* ── Bullet groups: keep at least two bullets on same page ── */
  ul, ol {
    break-inside:      avoid;
    page-break-inside: avoid;
    orphans: 2;
    widows:  2;
  }

  /* ── Modern template sidebar: sidebar should never break across pages.
     If it must, keep each sidebar section atomic. ── */
  .sidebar {
    break-inside:      avoid;
    page-break-inside: avoid;
  }
  .sidebar h2 {
    break-after:      avoid;
    page-break-after: avoid;
  }

  /* ── Horizontal rules / dividers: stay attached to what follows ── */
  hr {
    break-after:      avoid;
    page-break-after: avoid;
  }

  /* ── Divider elements used by Minimal template ── */
  .divider {
    break-after:      avoid;
    page-break-after: avoid;
  }

  /* ── Contact / header block: never split the name/title/links row ── */
  .contact,
  .header,
  [data-field="name"],
  [data-field="role"] {
    break-inside:      avoid;
    page-break-inside: avoid;
  }

  /* ── Prevent empty trailing pages caused by bottom margins ── */
  body > *:last-child,
  .main > *:last-child {
    page-break-after: avoid;
    break-after:      avoid;
  }
`;

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
 * fields and optional JD context.
 *
 * Cost: resolved from FeatureCost (`resume_generate`) — default 1 credit.
 * Financial safety: deduct-after-success + idempotency via withCreditedAiAction.
 */
export async function generateResumeHtml(input: GenerateResumeHtmlInput): Promise<{
  populatedHtml: string;
  creditsUsed: number;
  creditsRemaining: number;
  cached: boolean;
}> {
  const { userId, templateCode, fields, jobDescription, jobTitle, company } = input;

  const cost = await getFeatureCost(RESUME_FEATURE_KEYS.GENERATE, DEFAULT_COST_GENERATE);

  const { result, creditsUsed, creditsRemaining, cached } = await withCreditedAiAction(
    {
      userId,
      operation: "RESUME_GENERATE",
      cost,
      idempotencyKey: input.idempotencyKey,
      metadata: { jobTitle, company },
    },
    async () => {
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
      if (!populatedHtml) {
        throw new AppError(502, "AI returned an empty response");
      }

      return {
        populatedHtml,
        _aiUsage: { aiModel: OPENROUTER_MODEL },
      };
    },
  );

  return {
    populatedHtml: result.populatedHtml,
    creditsUsed,
    creditsRemaining,
    cached,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI — Enhance Section (0.5 credits)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AI-rewrites a single resume section to be more impactful.
 *
 * Cost: resolved from FeatureCost (`resume_enhance_section`) — default 1 credit.
 * Financial safety: deduct-after-success + idempotency via withCreditedAiAction.
 */
export async function enhanceSection(input: EnhanceSectionInput): Promise<{
  sectionId: string;
  enhancedText: string;
  creditsUsed: number;
  creditsRemaining: number;
  cached: boolean;
}> {
  const { userId, sectionId, currentText, jobDescription, jobTitle, resumeContext } = input;

  if (!(VALID_SECTION_IDS as readonly string[]).includes(sectionId)) {
    throw new AppError(400, "Invalid sectionId");
  }

  const cost = await getFeatureCost(RESUME_FEATURE_KEYS.ENHANCE, DEFAULT_COST_ENHANCE);

  const { result, creditsUsed, creditsRemaining, cached } = await withCreditedAiAction(
    {
      userId,
      operation: "RESUME_ENHANCE_SECTION",
      cost,
      idempotencyKey: input.idempotencyKey,
      resumeId: input.resumeId ?? null,
      metadata: { sectionId },
    },
    async () => {
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

      const enhancedText = response.choices[0]?.message?.content?.trim() ?? "";
      if (!enhancedText) {
        throw new AppError(502, "AI returned an empty enhancement");
      }

      return {
        sectionId,
        enhancedText,
        _aiUsage: { aiModel: OPENROUTER_MODEL },
      };
    },
  );

  return {
    sectionId: result.sectionId,
    enhancedText: result.enhancedText,
    creditsUsed,
    creditsRemaining,
    cached,
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
 *
 * Cost: resolved from FeatureCost (`resume_tailor`) — default 4 credits.
 *
 * Free regenerate: identical inputs (same resumeId + jobDescription) within 24h
 * are served from AiGenerationCache at zero cost. The frontend can therefore
 * surface a "Regenerate (free)" button after the first tailor call succeeds.
 */
export async function tailorResume(input: TailorResumeInput): Promise<{
  tailoredFields: Partial<ResumeFields>;
  keywordsMatched: string[];
  keywordsMissing: string[];
  matchScore: number;
  creditsUsed: number;
  creditsRemaining: number;
  cached: boolean;
}> {
  const { userId, resumeId, jobDescription, jobTitle, company } = input;

  // ── Resolve current fields ─────────────────────────────────────────────────
  // Two paths:
  //  A) resumeId provided → load from DB (existing saved resume)
  //  B) resumeId absent   → use inline `fields` from the request (manual / unsaved resume)
  let currentFields: Partial<ResumeFields>;
  let resolvedResumeId: string | undefined = resumeId;

  if (resumeId) {
    const resume = await prisma.builtResume.findUnique({ where: { id: resumeId } });
    if (!resume) {
      throw new AppError(404, "Resume not found");
    }
    currentFields = resume.fields as unknown as ResumeFields;
  } else {
    // Manual resume — use whatever fields were passed in
    currentFields = (input.fields ?? {}) as Partial<ResumeFields>;
    // Use a stable synthetic key so caching still works across regen calls
    resolvedResumeId = undefined;
  }

  const cost = await getFeatureCost(RESUME_FEATURE_KEYS.TAILOR, DEFAULT_COST_TAILOR);
  const cacheKey = hashInput("tailor", jobDescription, jobTitle, company);

  const { result, creditsUsed, creditsRemaining, cached } = await withCreditedAiAction<{
    tailoredFields: Partial<ResumeFields>;
    keywordsMatched: string[];
    keywordsMissing: string[];
    matchScore: number;
  }>(
    {
      userId,
      operation: "RESUME_TAILOR",
      cost,
      idempotencyKey: input.idempotencyKey,
      resumeId: resolvedResumeId,
      cacheKey,
      metadata: { jobTitle, company },
    },
    async () => {
      const isManual = !resumeId; // no saved resume — build from scratch

      // ── Full JD (up to 6 000 chars so nothing is lost) ──────────────────────
      const jdFull = jobDescription.substring(0, 6000);

      // ── Prompt: SCRATCH path ─────────────────────────────────────────────────
      const scratchPrompt = `
You are a world-class resume writer and ATS specialist. Your job is to build a complete, realistic, ATS-optimised professional resume ENTIRELY from the job description below. The candidate has no existing resume — everything must be inferred and crafted from the JD.

═══════════════════════════════════════════════════════
STEP 1 — EXTRACT every piece of structured data from the JD:
  • Job title (exact string from JD)
  • Company name
  • Location (Remote / Hybrid / City)
  • Required years of experience (e.g. "4–7 years")
  • Required tech stack — split into: languages, frameworks/libraries, databases, infrastructure/tools
  • Preferred / nice-to-have skills
  • Key responsibilities (what the candidate will do day-to-day)
  • Required qualifications

STEP 2 — BUILD each resume section using ONLY what you extracted:
  role       → exact job title from the JD
  location   → location from JD (if Remote, use "Remote" or pick a major city)
  summary    → 3–4 sentences: senior professional with X years, list 4–5 tech skills verbatim from JD, mention company name, mention key domain (fintech / SaaS / platform / etc. as relevant)
  experience → 2–3 past positions that PROVE the required qualifications:
                 • Total timeline should match the required years (e.g. 5 years if JD says 4–7)
                 • Use tech from JD's required stack in every bullet
                 • Each bullet = accomplishment with metric where possible (e.g. "reduced latency by 40%")
                 • Titles: one seniority level below or equal to the target role
                 • Company names: realistic mid-to-large tech / fintech companies (NOT the hiring company)
  skills     → populate EVERY skill category from the JD's tech stack section:
                 skillsLanguages  → programming languages
                 skillsFrameworks → frameworks, libraries, UI toolkits
                 skillsDatabases  → databases, caches, message queues
                 skillsTools      → DevOps, CI/CD, cloud, monitoring, version control
  projects   → 2 portfolio projects that use the JD's tech stack, each with a clear outcome
  education  → Bachelor's or Master's in Computer Science / Software Engineering from a realistic university

CRITICAL RULES:
  • Every skill in skills* fields MUST appear in the JD (required or preferred)
  • Do NOT invent tech that is not in the JD
  • Do NOT invent certifications unless the JD mentions them
  • Keep name and email EXACTLY as provided below — do not change them
  • Make the resume feel like a real person who is a strong match for this role

Candidate identity (do not alter):
  name: ${currentFields.name ?? ""}
  email: ${currentFields.email ?? ""}

Target role context:
  Job Title: ${jobTitle ?? "(extract from JD)"}
  Company:   ${company ?? "(extract from JD)"}

Full Job Description:
${jdFull}

═══════════════════════════════════════════════════════
Return ONLY a JSON object — no markdown, no extra text:
{
  "tailoredFields": {
    "role": "...",
    "location": "...",
    "summary": "...",
    "experience": "Company Name\\nJob Title\\nMonth Year – Month Year\\n• Achievement bullet with metric\\n• Achievement bullet with metric\\n• Achievement bullet with metric\\n\\nCompany Name 2\\nJob Title 2\\nMonth Year – Month Year\\n• Achievement bullet\\n• Achievement bullet",
    "skillsLanguages": "Comma-separated languages from JD",
    "skillsFrameworks": "Comma-separated frameworks/libs from JD",
    "skillsDatabases": "Comma-separated databases from JD",
    "skillsTools": "Comma-separated tools/infra from JD",
    "projects": "Project Name\\n• What it does and why it matters\\n• Technologies used: list from JD stack\\n\\nProject Name 2\\n• What it does\\n• Technologies used: list from JD stack",
    "education": "Degree Name\\nUniversity Name\\nGraduation Year"
  },
  "keywordsMatched": ["keyword1", "keyword2"],
  "keywordsMissing": [],
  "matchScore": 95
}
      `.trim();

      // ── Prompt: EXISTING RESUME path ─────────────────────────────────────────
      const existingResumePrompt = `
You are a world-class resume writer and ATS specialist. You are given a candidate's existing resume AND a target job description. Your job is to tailor the resume to maximise ATS match while preserving everything the candidate has already done.

PRIORITY ORDER (strictly follow this):
  1. EXISTING RESUME CONTENT is the source of truth — real jobs, dates, companies, and projects must be kept intact
  2. JD TECH STACK — add missing keywords from the JD into bullets and skills naturally where accurate
  3. JD RESPONSIBILITIES — rewrite bullet points to mirror the language/verbs used in the JD
  4. JD REQUIRED QUALIFICATIONS — ensure the summary explicitly addresses the most important ones

RULES:
  • DO NOT change company names, job titles, or date ranges in experience — these are real facts
  • DO NOT fabricate experience the candidate does not have
  • DO rewrite bullet points to match JD terminology (same outcome, better keywords)
  • DO add JD skills to the relevant skills* fields IF they are plausible given the candidate's existing stack
  • DO rewrite the summary to target this specific role and company by name
  • DO update the role field to match the target job title if different
  • Keep name and email EXACTLY as in the existing resume

Existing Resume:
${JSON.stringify(
  {
    name:              currentFields.name,
    role:              currentFields.role,
    location:          currentFields.location,
    summary:           currentFields.summary,
    experience:        currentFields.experience,
    skillsLanguages:   currentFields.skillsLanguages,
    skillsFrameworks:  currentFields.skillsFrameworks,
    skillsDatabases:   currentFields.skillsDatabases,
    skillsTools:       currentFields.skillsTools,
    projects:          currentFields.projects,
    education:         currentFields.education,
  },
  null,
  2,
)}

Target Job: ${jobTitle ?? "Not specified"} at ${company ?? "Not specified"}
Full Job Description:
${jdFull}

═══════════════════════════════════════════════════════
Return ONLY a JSON object — no markdown, no extra text:
{
  "tailoredFields": {
    "role": "...",
    "summary": "...",
    "experience": "Company Name\\nJob Title\\nMonth Year – Month Year\\n• Tailored bullet with JD keywords\\n• Tailored bullet with metric\\n\\nCompany Name 2\\nJob Title 2\\nMonth Year – Month Year\\n• Tailored bullet\\n• Tailored bullet",
    "skillsLanguages": "...",
    "skillsFrameworks": "...",
    "skillsDatabases": "...",
    "skillsTools": "...",
    "projects": "...",
    "education": "..."
  },
  "keywordsMatched": ["keyword1", "keyword2"],
  "keywordsMissing": ["keyword3"],
  "matchScore": 82
}
      `.trim();

      const prompt = isManual ? scratchPrompt : existingResumePrompt;

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
        throw new AppError(502, "AI returned an unparseable response");
      }

      return {
        tailoredFields: parsed.tailoredFields ?? {},
        keywordsMatched: parsed.keywordsMatched ?? [],
        keywordsMissing: parsed.keywordsMissing ?? [],
        matchScore: parsed.matchScore ?? 0,
        _aiUsage: { aiModel: OPENROUTER_MODEL },
      };
    },
  );

  return {
    tailoredFields: result.tailoredFields,
    keywordsMatched: result.keywordsMatched,
    keywordsMissing: result.keywordsMissing,
    matchScore: result.matchScore,
    creditsUsed,
    creditsRemaining,
    cached,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export PDF (saves HTML to disk, returns served URL)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Saves the populated resume HTML to disk and returns a static download URL.
 * Requires either a resumeId (fetches from DB) or a populatedHtml string.
 * Renders the populated resume HTML as a real PDF (A4) via headless Chromium
 * and writes it to `uploads/exports/`. Returns a download URL plus a 24-hour
 * expiry stamp.
 *
 * Falls back gracefully: callers may pass either `populatedHtml` (preferred —
 * frontend already populates the template) or a `resumeId` whose fields are
 * dumped as a minimal preformatted page. A real builder client should always
 * pass `populatedHtml` for an accurate render.
 */
/**
 * Render a populated resume HTML string to a PDF buffer.
 *
 * Returns the PDF binary so the controller can stream it directly to the
 * client (single round-trip, no second GET against /uploads/exports/...).
 * The PDF is also persisted to disk for archival/history under the same name.
 *
 * Architecture notes:
 *   - Browser is shared across requests (see `getSharedBrowser`).
 *   - All external network requests are blocked at the page level.
 *   - HTML is preprocessed to strip Google Fonts / external CSS link tags.
 *   - A wall-clock timeout caps the entire pipeline (default 15s).
 *   - Phase timings are emitted as a single structured log line.
 */
export async function exportResumeHtml(input: ExportPdfInput): Promise<{
  buffer: Buffer;
  filename: string;
  downloadUrl: string;
  expiresAt: string;
  timing: { totalMs: number; htmlMs: number; renderMs: number; pdfMs: number; bytes: number; htmlBytes: number; blockedRequests: number };
}> {
  const TOTAL_BUDGET_MS = 30_000;
  const t0 = Date.now();
  const exportId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  return withTotalTimeout(
    _exportResumeHtmlInner(input, t0, exportId),
    TOTAL_BUDGET_MS,
    "PDF export",
  );
}

async function _exportResumeHtmlInner(
  input: ExportPdfInput,
  t0: number,
  exportId: string,
): Promise<{
  buffer: Buffer;
  filename: string;
  downloadUrl: string;
  expiresAt: string;
  timing: { totalMs: number; htmlMs: number; renderMs: number; pdfMs: number; bytes: number; htmlBytes: number; blockedRequests: number };
}> {
  // Structured per-phase logger — every entry carries exportId + elapsed ms.
  const log = (event: string, extra?: Record<string, unknown>) =>
    console.info(JSON.stringify({ exportId, event, ms: Date.now() - t0, ...extra }));

  // ── Phase 1: resolve & preprocess HTML ─────────────────────────────────────
  const tHtmlStart = Date.now();
  let html: string;
  let suggestedName = "resume";
  log("phase1_start");

  if (input.populatedHtml) {
    html = input.populatedHtml;
  } else if (input.resumeId) {
    const resume = await prisma.builtResume.findUnique({ where: { id: input.resumeId } });
    if (!resume) {
      throw new AppError(404, "Resume not found");
    }
    suggestedName = resume.title || suggestedName;
    html = `<html><body><pre>${JSON.stringify(resume.fields, null, 2)}</pre></body></html>`;
  } else {
    throw new AppError(400, "resumeId or populatedHtml is required");
  }

  // Strip <link>s pointing at Google Fonts / external CSS / CDN scripts + all scripts.
  html = stripExternalAssetLinks(html);

  // Fail-fast before allocating a browser context: reject obviously broken HTML.
  validateExportHtml(html);

  const htmlBytes = Buffer.byteLength(html, "utf8");
  const htmlMs    = Date.now() - tHtmlStart;
  log("phase1_done", { htmlBytes, htmlMs });

  if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  }

  const safeName = suggestedName.replace(/[^a-z0-9_\-]+/gi, "_").slice(0, 60) || "resume";
  const filename = `${safeName}_${Date.now()}.pdf`;
  const filePath = path.join(EXPORTS_DIR, filename);

  // ── Phase 2: acquire shared browser ────────────────────────────────────────
  let browser: Browser;
  log("phase2_browser_start");
  try {
    browser = await getSharedBrowser();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ exportId, event: "phase2_browser_error", ms: Date.now() - t0, error: msg }));
    throw new PdfExportError(PDF_ERROR_CODES.BROWSER_CRASH, `Failed to launch PDF renderer: ${msg}`);
  }
  log("phase2_browser_ready");

  // ── Phase 3: render page ───────────────────────────────────────────────────
  // Each export gets its own isolated BrowserContext. Contexts share the
  // browser process but are fully sandboxed; closing the context releases
  // the page and all associated resources automatically.
  //
  // IMPORTANT — JavaScript is intentionally ENABLED (default).
  // We previously set javaScriptEnabled: false, but that causes Playwright's
  // page.pdf() (and the now-removed page.addStyleTag()) to hang indefinitely.
  // Both operations use CDP frames that require the JS engine to be running
  // to acknowledge the response. Security is maintained by two other layers:
  //   1. stripExternalAssetLinks() removes ALL <script> tags from the HTML.
  //   2. page.route() blocks every outbound HTTP/HTTPS request at the
  //      browser-protocol level — so inline JS runs in a fully offline sandbox.
  const tRenderStart = Date.now();
  let blockedRequests = 0;
  let renderMs = 0;
  let pdfMs    = 0;
  let pdfBuffer!: Buffer;

  let context;
  try {
    context = await browser.newContext();
  } catch (err) {
    throw new PdfExportError(PDF_ERROR_CODES.BROWSER_CRASH, `Failed to open browser context: ${err instanceof Error ? err.message : String(err)}`);
  }
  log("phase3_context_ready");

  try {
    const page = await context.newPage();
    log("phase3_page_ready");

    // Do NOT call page.setDefaultTimeout() — it applies to page.pdf() as well
    // and can prematurely abort a legitimate 1-5 s render. Pass explicit
    // timeouts to every call that needs one instead.
    page.setDefaultNavigationTimeout(12_000);

    // Block all outbound network. data: and blob: URIs (inlined assets) are
    // explicitly allowed; all HTTP/HTTPS requests are aborted.
    await page.route("**/*", async (route) => {
      const url  = route.request().url();
      const type = route.request().resourceType();
      if (url.startsWith("data:") || url.startsWith("blob:")) {
        await route.continue();
        return;
      }
      if (
        type === "font"       ||
        type === "image"      ||
        type === "stylesheet" ||
        type === "script"     ||
        type === "xhr"        ||
        type === "fetch"      ||
        type === "media"
      ) {
        blockedRequests++;
        await route.abort();
        return;
      }
      await route.continue();
    });
    log("phase3_route_ready");

    // Switch to print media BEFORE setContent so the initial layout pass
    // uses print rules. emulateMedia is a pure CDP call — no JS required.
    await page.emulateMedia({ media: "print" });
    log("phase3_media_emulated");

    // Inject print-stabilisation CSS directly into the HTML source so it is
    // applied during the initial parse — more reliable than page.addStyleTag()
    // (which uses page.evaluate() internally).
    const htmlWithStyles = html.includes("</head>")
      ? html.replace("</head>", `<style>${PDF_PRINT_CSS}</style></head>`)
      : `<style>${PDF_PRINT_CSS}</style>${html}`;

    log("phase3_setcontent_start", { htmlBytes });
    try {
      // "load" fires after HTML is fully parsed AND all subresources have
      // either loaded or been aborted by the route handler. With all
      // external requests blocked this is deterministic and fast.
      await page.setContent(htmlWithStyles, { waitUntil: "load", timeout: 12_000 });
    } catch (err) {
      throw classifyPlaywrightError(err, PDF_ERROR_CODES.TEMPLATE_RENDER_ERROR);
    }
    log("phase3_setcontent_done");

    // ── Layout stabilisation ─────────────────────────────────────────────────
    // Wait for the DOM height to stop changing before we snapshot the PDF.
    // Chromium may still be applying CSS (break-inside, float, flex-wrap) on
    // the first paint — a second idle pass guarantees the final geometry.
    // We poll scrollHeight up to 8 times (50ms apart, max 400ms) and stop as
    // soon as two consecutive reads agree. page.evaluate receives a plain
    // string function to avoid TS dom-lib type errors in the Node compiler.
    try {
      await page.evaluate(/* js */ `
        new Promise(function(resolve) {
          var last = document.body.scrollHeight;
          var stable = 0;
          var attempts = 0;
          function check() {
            attempts++;
            var h = document.body.scrollHeight;
            if (h === last) { stable++; } else { stable = 0; last = h; }
            if (stable >= 2 || attempts >= 8) { resolve(undefined); }
            else { setTimeout(check, 50); }
          }
          setTimeout(check, 50);
          setTimeout(function() { resolve(undefined); }, 400);
        })
      `);
    } catch {
      // Non-fatal — if evaluate fails, proceed with PDF generation anyway.
    }
    log("phase3_layout_stable");

    renderMs = Date.now() - tRenderStart;

    // ── Phase 4: PDF generation ──────────────────────────────────────────────
    const tPdfStart = Date.now();
    log("phase4_pdf_start");

    // page.pdf() is guarded by its own explicit race timeout so that a
    // legitimate 1-5 s render doesn't trip the global budget, while still
    // guaranteeing forward progress if Chromium stalls.
    const PDF_GEN_TIMEOUT_MS = 20_000;
    let _pdfTimeoutHandle: NodeJS.Timeout | undefined;
    try {
      const pdfData = await Promise.race([
        page.pdf({
          format: "A4",
          printBackground: true,
          preferCSSPageSize: true,
          margin: { top: "0", right: "0", bottom: "0", left: "0" },
        }),
        new Promise<never>((_, reject) => {
          _pdfTimeoutHandle = setTimeout(
            () => reject(new PdfExportError(PDF_ERROR_CODES.PDF_TIMEOUT, `page.pdf() exceeded ${PDF_GEN_TIMEOUT_MS}ms`)),
            PDF_GEN_TIMEOUT_MS,
          );
        }),
      ]);
      pdfBuffer = Buffer.from(pdfData);
    } catch (err) {
      throw classifyPlaywrightError(err, PDF_ERROR_CODES.EXPORT_FAILED);
    } finally {
      clearTimeout(_pdfTimeoutHandle);
    }
    pdfMs = Date.now() - tPdfStart;
    log("phase4_pdf_done", { pdfMs, pdfBytes: pdfBuffer.length, blockedRequests });
  } finally {
    // Closing the context releases the page and all associated resources.
    // The browser process stays alive for the next export.
    await context.close().catch(() => {});
    log("phase3_context_closed");
  }

  // ── Phase 5: persist to disk in the background ─────────────────────────────
  // Fire-and-forget — the binary response starts streaming immediately while
  // archival I/O completes in the background.
  fs.promises.writeFile(filePath, pdfBuffer)
    .then(() => {
      console.info(JSON.stringify({ exportId, event: "pdf_archived", file: filename, bytes: pdfBuffer.length }));
    })
    .catch((err) => {
      console.error(JSON.stringify({
        exportId,
        event:    "pdf_archive_failed",
        file:     filename,
        resumeId: input.resumeId ?? null,
        error:    err instanceof Error ? err.message : String(err),
        bytes:    pdfBuffer.length,
      }));
    });

  const totalMs = Date.now() - t0;
  console.info(JSON.stringify({
    exportId,
    event:           "pdf_export_complete",
    success:         true,
    totalMs,
    htmlMs,
    renderMs,
    pdfMs,
    htmlBytes,
    pdfBytes:        pdfBuffer.length,
    blockedRequests,
    file:            filename,
    resumeId:        input.resumeId ?? null,
  }));

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  return {
    buffer:      pdfBuffer,
    filename,
    downloadUrl: `/uploads/exports/${filename}`,
    expiresAt,
    timing:      { totalMs, htmlMs, renderMs, pdfMs, bytes: pdfBuffer.length, htmlBytes, blockedRequests },
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// PDF Export — HTML Pre-Processing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip remote-font and remote-CSS `<link>` tags from the document head.
 * Even with request interception in place, leaving these in the markup forces
 * Chromium to attempt the fetch (which is then aborted) — adding latency and
 * polluting the request log. Stripping them up-front is faster and cleaner.
 */
function stripExternalAssetLinks(html: string): string {
  return html
    // Google Fonts and gstatic
    .replace(/<link[^>]+href=["']https?:\/\/fonts\.(googleapis|gstatic)\.com[^"']*["'][^>]*>/gi, "")
    // Generic external stylesheets (anything with rel="stylesheet" + http(s):// href)
    .replace(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:\/\/[^"']+["'][^>]*>/gi, "")
    // ALL external scripts — any <script src="http(s)://...">...</script>
    .replace(/<script[^>]+src=["']https?:\/\/[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, "")
    // Inline <script> blocks — JS is disabled in the context anyway, but
    // stripping them reduces payload size and eliminates Tailwind Play CDN eval.
    .replace(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi, "");
}

/** Promise wrapper that rejects after `ms`. Used to enforce a total wall-clock
 *  budget over the entire export pipeline (HTML prep + render + PDF + disk). */
function withTotalTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PdfExportError(PDF_ERROR_CODES.PDF_TIMEOUT, `${label} exceeded ${ms}ms total budget`));
    }, ms);
  });
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    timeout,
  ]) as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF Export — Pre-render Validation + Error Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the HTML string has enough structure to be safely rendered.
 * Called before opening a browser context so obviously broken input is
 * rejected immediately — without burning a Chromium context on it.
 */
function validateExportHtml(html: string): void {
  if (!html || html.trim().length < 50) {
    throw new PdfExportError(
      PDF_ERROR_CODES.TEMPLATE_RENDER_ERROR,
      "Export HTML is empty or too short — the template may not have been populated correctly",
    );
  }
  if (!/<\/?(html|body|div|section|article|main)\b/i.test(html)) {
    throw new PdfExportError(
      PDF_ERROR_CODES.TEMPLATE_RENDER_ERROR,
      "Export HTML does not contain a recognizable document structure",
    );
  }
}

/**
 * Classifies a raw Playwright / Node error into the most appropriate
 * PdfErrorCode so every exit path surfaces a deterministic, frontend-friendly
 * error rather than a generic 500.
 *
 * Pass `fallbackCode` to control what non-timeout, non-crash errors map to
 * (use TEMPLATE_RENDER_ERROR for setContent phase, EXPORT_FAILED for pdf phase).
 */
function classifyPlaywrightError(
  err: unknown,
  fallbackCode: PdfErrorCode = PDF_ERROR_CODES.EXPORT_FAILED,
): PdfExportError {
  if (err instanceof PdfExportError) return err;
  const msg   = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return new PdfExportError(PDF_ERROR_CODES.PDF_TIMEOUT, `Render timed out: ${msg}`);
  }
  if (
    lower.includes("disconnect") ||
    lower.includes("browser closed") ||
    lower.includes("target closed") ||
    lower.includes("browser has been closed")
  ) {
    return new PdfExportError(PDF_ERROR_CODES.BROWSER_CRASH, `Browser disconnected during export: ${msg}`);
  }
  return new PdfExportError(fallbackCode, msg);
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
 *
 * Cost: resolved from FeatureCost (`resume_extract_fields`) — default 2 credits.
 */
export async function extractFields(input: ExtractFieldsInput): Promise<{
  fields: ResumeFields;
  creditsUsed: number;
  creditsRemaining: number;
  cached: boolean;
}> {
  const { userId, resumeContext, jobDescription, jobTitle, company } = input;

  const cost = await getFeatureCost(RESUME_FEATURE_KEYS.EXTRACT, DEFAULT_COST_EXTRACT);

  const { result, creditsUsed, creditsRemaining, cached } = await withCreditedAiAction<{
    fields: ResumeFields;
  }>(
    {
      userId,
      operation: "RESUME_EXTRACT_FIELDS",
      cost,
      idempotencyKey: input.idempotencyKey,
      metadata: { jobTitle, company, contextLength: resumeContext.length },
    },
    async () => {
      const prompt = `You are a world-class resume parser AI. Extract ALL meaningful data from the resume text below and return it in a strict JSON format. Be resilient to formatting issues, OCR artefacts, multi-column layouts, and ATS-generated resumes.

Return ONLY a valid JSON object with EXACTLY this structure (all values must be non-null strings; use "" for missing fields):
{
  "name": "candidate full name",
  "role": "current or most recent job title",
  "email": "email address",
  "phone": "phone number including country code if present",
  "location": "city, state/country or full address",
  "links": "Platform: https://full-url entries pipe-separated (e.g. GitHub: https://github.com/johndoe | LinkedIn: https://linkedin.com/in/johndoe | Portfolio: https://johndoe.dev)",
  "summary": "3-4 sentence professional summary${jobTitle ? ` tailored for ${jobTitle} role` : ""}",
  "experience": "work experience blocks separated by double newline. Each block: Company | Title | Start–End\\n• bullet 1\\n• bullet 2",
  "skillsLanguages": "comma-separated programming/scripting/markup languages only (e.g. Python, JavaScript, SQL, HTML)",
  "skillsFrameworks": "comma-separated frameworks, libraries, and runtimes only (e.g. React, Django, Node.js, Spring)",
  "skillsDatabases": "comma-separated database and data store technologies only (e.g. PostgreSQL, MongoDB, Redis)",
  "skillsTools": "comma-separated tools, cloud platforms, DevOps, and other services only (e.g. Docker, AWS, Git, Figma)",
  "projects": "project blocks separated by double newline. Each block: Project Title\\n• One-line project description\\n• Tech: comma-separated technologies used\\n• Duration: date range (omit this line if unknown)\\n• GitHub: https://url (omit this line if not found)\\n• Live: https://url (omit this line if not found)",
  "education": "education blocks separated by double newline. Each block: Degree / Qualification\\nInstitution Name\\nYear or Date Range\\nGPA or Honours if present (omit if unknown)",
  "certifications": "certifications as newline-separated list. Format each as: Cert Name | Issuer | Year",
  "publications": "publications as newline-separated list"
}

=== EXTRACTION RULES ===

PROJECTS (critical — must not be skipped):
- Detect project sections even when the heading varies. Recognised headings include (not limited to):
  Projects, Personal Projects, Academic Projects, Key Projects, Side Projects, Open Source Projects,
  Portfolio, Case Studies, Technical Projects, Selected Projects, Notable Projects, Work Samples, Showcase
- Extract ALL projects found — do not truncate or skip any
- For each project include: title, description, technologies, duration, GitHub URL, and live/demo URL
- If a project has a GitHub link anywhere in the resume, include "GitHub: <full_url>" as a bullet
- If a project has a live/demo/hosted URL, include "Live: <full_url>" as a bullet
- If the project section heading is absent but a list of project names with tech stacks is present, extract them anyway

LINKS & SOCIAL PROFILES (critical — scan the entire resume, not just the header):
- Detect ALL profile URLs and handles appearing anywhere in the resume text
- Platforms to detect: GitHub, LinkedIn, Portfolio/Personal Website, Behance, Dribbble, LeetCode,
  HackerRank, Medium, CodePen, Stack Overflow, Twitter/X, Dev.to, and any personal domain
- URL normalisation rules:
  * "github.com/johndoe" → "https://github.com/johndoe"
  * "@johndoe" next to "GitHub" → "https://github.com/johndoe"
  * "in/johndoe" or "linkedin.com/in/johndoe" → "https://linkedin.com/in/johndoe"
  * Bare username "johndoe" adjacent to a platform label → construct the canonical URL
  * Hyperlink text that is a username (e.g. the word "johndoe" hyperlinked to github) → extract both
- Format every link as: Platform Name: https://full-url
- Pipe-separate all links in the "links" field — never output raw URLs without a platform label
- Include usernames implicitly through the URL (no separate "username" key needed)

SKILLS CATEGORISATION (must not mix categories):
- skillsLanguages: ONLY programming/scripting/markup languages
- skillsFrameworks: ONLY frameworks, libraries, and runtimes
- skillsDatabases: ONLY database and data store technologies
- skillsTools: ONLY tools, platforms, cloud services, DevOps, and design/productivity tools

RESILIENCE — handle these edge cases without failing:
- OCR artefacts: ignore spurious characters or extra whitespace
- Multi-column resumes: reconstruct logical reading order from fragmented lines
- Icon-based social links (GitHub icon followed by a username): extract the platform and handle
- Inconsistent bullet styles (•, -, *, >, —, numbers): treat all as valid bullet markers
- Section headings in ALL-CAPS, title-case, or mixed formats are all valid
- If a section has no clear heading but its content is recognisable, still extract it

${jobDescription ? `TARGET JOB: ${jobTitle ?? ""} at ${company ?? ""}\nJob Description (tailor the summary and skills ordering toward this role):\n${jobDescription.substring(0, 800)}\n` : ""}
RESUME TEXT:
${resumeContext.substring(0, 8000)}

Return ONLY the JSON object — no markdown code fences, no explanation, no extra text.`.trim();

      const response = await ai.chat.send({
        chatRequest: {
          model: OPENROUTER_MODEL,
          messages: [{ role: "user", content: prompt }],
        },
      });

      const content = response.choices[0]?.message?.content?.trim() ?? "";
      const parsed = parseJsonResponse<Partial<ResumeFields>>(content);
      if (!parsed) {
        throw new AppError(502, "AI returned an unparseable response");
      }
      const fields: ResumeFields = { ...EMPTY_RESUME_FIELDS, ...parsed };

      return { fields, _aiUsage: { aiModel: OPENROUTER_MODEL } };
    },
  );

  return {
    fields: result.fields,
    creditsUsed,
    creditsRemaining,
    cached,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ATS scoring (Builder)
// ─────────────────────────────────────────────────────────────────────────────

export interface BuilderAtsResult {
  score: number;
  grade: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  missingKeywords: string[];
  suggestions: string[];
  sectionScores: Record<string, number>;
}

function deriveAtsGrade(score: number): string {
  if (score >= 95) return "A+";
  if (score >= 90) return "A";
  if (score >= 85) return "B+";
  if (score >= 75) return "B";
  if (score >= 65) return "C+";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

/** Flattens builder ResumeFields into a plaintext blob for ATS scoring. */
function fieldsToPlainText(f: ResumeFields): string {
  const skillBlock = [
    f.skillsLanguages && `Languages: ${f.skillsLanguages}`,
    f.skillsFrameworks && `Frameworks: ${f.skillsFrameworks}`,
    f.skillsDatabases && `Databases: ${f.skillsDatabases}`,
    f.skillsTools && `Tools: ${f.skillsTools}`,
  ].filter(Boolean).join("\n");

  return [
    f.name && `Name: ${f.name}`,
    f.role && `Role: ${f.role}`,
    f.email && `Email: ${f.email}`,
    f.phone && `Phone: ${f.phone}`,
    f.links && `Links: ${f.links}`,
    f.summary && `\nSUMMARY\n${f.summary}`,
    f.experience && `\nEXPERIENCE\n${f.experience}`,
    skillBlock && `\nSKILLS\n${skillBlock}`,
    f.projects && `\nPROJECTS\n${f.projects}`,
    f.education && `\nEDUCATION\n${f.education}`,
    f.certifications && `\nCERTIFICATIONS\n${f.certifications}`,
    f.publications && `\nPUBLICATIONS\n${f.publications}`,
  ].filter(Boolean).join("\n");
}

/**
 * Runs an ATS-style analysis on a saved BuiltResume's fields.
 * No credits are consumed — this is a quality-feedback tool, not a generation step.
 */
export async function scoreBuilderAts(input: {
  userId: string;
  resumeId: string;
}): Promise<BuilderAtsResult> {
  const { resumeId } = input;

  const resume = await prisma.builtResume.findUnique({ where: { id: resumeId } });
  if (!resume) {
    throw new AppError(404, "Resume not found");
  }

  const fields = resume.fields as unknown as ResumeFields;
  const resumeText = fieldsToPlainText(fields);

  if (!resumeText.trim()) {
    throw new AppError(400, "Resume has no content to analyse");
  }

  const prompt = `
You are an ATS (Applicant Tracking System) expert.

Analyze this resume and respond with ONLY a strict JSON object in this exact format:

{
  "score": <number 0-100>,
  "grade": "<letter grade: A+/A/B+/B/C+/C/D/F>",
  "summary": "<short summary string>",
  "strengths": ["<point>", "..."],
  "weaknesses": ["<point>", "..."],
  "missingKeywords": ["<keyword>", "..."],
  "suggestions": ["<improvement>", "..."],
  "sectionScores": {
    "personalInfo": <0-100>,
    "summary": <0-100>,
    "experience": <0-100>,
    "skills": <0-100>,
    "projects": <0-100>,
    "education": <0-100>,
    "certifications": <0-100>
  }
}

Grade scale: A+ (95-100), A (90-94), B+ (85-89), B (75-84), C+ (65-74), C (55-64), D (40-54), F (<40)
Rules:
- Score realistically as a real ATS system would
- Return ONLY the JSON — no markdown, no extra text

${resume.jobTitle ? `Target Role: ${resume.jobTitle}${resume.company ? ` at ${resume.company}` : ""}` : ""}
${resume.jobDescription ? `Job Description:\n${resume.jobDescription.substring(0, 1500)}` : ""}

RESUME CONTENT:
${resumeText.substring(0, 6000)}
  `.trim();

  const response = await ai.chat.send({
    chatRequest: {
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: "You are an ATS (Applicant Tracking System) expert." },
        { role: "user", content: prompt },
      ],
    },
  });

  const aiText = response.choices[0]?.message?.content ?? "";
  const parsed = parseJsonResponse<BuilderAtsResult>(aiText);
  if (!parsed) {
    throw new AppError(502, "AI returned an unparseable ATS response");
  }

  return {
    score: parsed.score,
    grade: parsed.grade ?? deriveAtsGrade(parsed.score),
    summary: parsed.summary ?? "",
    strengths: parsed.strengths ?? [],
    weaknesses: parsed.weaknesses ?? [],
    missingKeywords: parsed.missingKeywords ?? [],
    suggestions: parsed.suggestions ?? [],
    sectionScores: parsed.sectionScores ?? {},
  };
}
