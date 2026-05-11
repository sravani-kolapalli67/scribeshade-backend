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
  RewriteResumeInput,
  InjectSkillsInput,
  InjectKeywordsInput,
  KeywordMatchInput,
  KeywordMatchResult,
} from "./resume.types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL;

// Resume tailoring is a complex multi-section structured-rewrite task that small
// open-weight models (e.g. Gemma 4) handle poorly — they tend to echo the input
// instead of rewriting. Override with a stronger reasoning model just for this
// task. Configurable via OPENROUTER_RESUME_TAILOR_MODEL env var.
const TAILOR_MODEL =
  process.env.OPENROUTER_RESUME_TAILOR_MODEL ||
  "anthropic/claude-sonnet-4.5";
// Absolute path — safe across Docker, PM2, and any working-directory variation.
const EXPORTS_DIR = path.resolve(process.cwd(), "uploads/exports");

const VALID_SECTION_IDS = [
  "personalInfo",
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
  REWRITE: "resume_rewrite",
  INJECT_SKILLS: "resume_inject_skills",
  INJECT_KEYWORDS: "resume_inject_keywords",
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

export async function renameBuiltResume(
  id: string,
  title: string,
): Promise<{ id: string; filename: string }> {
  const trimmed = title.trim();
  if (!trimmed) throw new AppError(400, "Title cannot be empty");

  const resume = await prisma.builtResume.findUnique({ where: { id } });
  if (!resume) throw new AppError(404, "Resume not found");

  const updated = await prisma.builtResume.update({
    where: { id },
    data: { title: trimmed },
    select: { id: true, title: true },
  });

  return { id: updated.id, filename: `${updated.title}.pdf` };
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
  const { userId, sectionId, currentText, jobDescription, jobTitle, resumeContext, qualityIssues, qualitySuggestions } = input;

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
      // personalInfo enhancement = improve the professional title/role line only
      // (name/email are locked and must not be altered)
      const isPersonalInfo = sectionId === "personalInfo";

      const prompt = isPersonalInfo
        ? `
You are an expert resume writer. The candidate's professional title / role line needs to be more specific, impactful, and ATS-friendly.

Current title/role: ${currentText}
${jobDescription ? `Target job description context: ${jobDescription.substring(0, 500)}` : ""}
${jobTitle ? `Target job title: ${jobTitle}` : ""}

Instructions:
- Return ONLY the improved professional title string (e.g. "Senior Full Stack Engineer – Platform & Payments")
- Make it specific, keyword-rich, and aligned to the target role if provided
- Do NOT include name, email, phone, or location — just the title
- Maximum 10 words
- No explanation, no punctuation at the end
        `.trim()
        : `
You are an expert resume writer. Rewrite the following resume section to be more impactful, quantified, and ATS-friendly.

Section: ${sectionId}
${resumeContext ? `Full resume context: ${resumeContext.substring(0, 1000)}` : ""}
${jobDescription ? `Target role: ${jobTitle ?? ""}\nJob description: ${jobDescription.substring(0, 800)}` : ""}

Current text:
${currentText}
${(qualityIssues && qualityIssues.length > 0) ? `
QUALITY ISSUES TO FIX (identified by the section quality scorer — you MUST resolve all of these):
${qualityIssues.map((issue, i) => `${i + 1}. ${issue}`).join("\n")}` : ""}
${(qualitySuggestions && qualitySuggestions.length > 0) ? `
SUGGESTED IMPROVEMENTS (apply all of these):
${qualitySuggestions.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : ""}

Instructions:
- Use strong action verbs.
- Add quantified impact where possible (e.g. "reduced load time by 40%").
- Keep the same format (plain text, not HTML).
${(qualityIssues && qualityIssues.length > 0) ? "- The QUALITY ISSUES above are the most important things to fix — prioritise them above all else." : ""}
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
  const _isManualForCache = !resumeId;
  const cacheKey = hashInput("tailor_v9_locked_fields", jobTitle ?? "", company ?? "", jobDescription, _isManualForCache ? "scratch" : "existing");

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
      // "scratch" = truly no resume context — AI invents everything (Path B: from JD only).
      // "existing" = has uploaded/saved resume fields → use truth-preserving rewrite engine.
      // Key fix: inline fields passed without a resumeId (wizard upload flow) are still
      // "existing resume" context — NOT scratch. Only treat as scratch when fields are empty.
      const hasInlineFields =
        input.fields != null && Object.values(input.fields).some((v) => v && v.trim().length > 0);
      const isManual = !resumeId && !hasInlineFields; // true only when truly building from JD alone

      // ── Full JD (up to 6 000 chars so nothing is lost) ──────────────────────
      const jdFull = jobDescription.substring(0, 6000);
      const hasJD  = jdFull.trim().length >= 50;

      // ── Resolve target role: explicit input wins, else extract from JD ───────
      // Extract the first line of the JD that looks like a job title so the AI
      // always has a concrete target — never falls back to inferring from resume.
      const resolvedJobTitle = (jobTitle && jobTitle.trim())
        ? jobTitle.trim()
        : (() => {
            // Try to pull "Job Title: X" or the first short line from JD
            const match = jdFull.match(/(?:job\s*title|position|role)\s*[:\-–]\s*([^\n]+)/i)
              ?? jdFull.match(/^(.{5,60})\n/);
            return match ? match[1].trim() : "";
          })();
      const resolvedCompany = (company && company.trim()) ? company.trim() : "";

      console.log("[resume.tailor] resolvedJobTitle:", resolvedJobTitle, "| resolvedCompany:", resolvedCompany);

      // ─────────────────────────────────────────────────────────────────────────
      // SCRATCH PROMPT
      // Build a complete resume from Job Title alone (JD is optional bonus).
      // Skills come from the LATEST industry-standard tech for the role in 2026,
      // not blindly from the JD — so a "Senior React Engineer" always gets
      // React 18, TypeScript, Next.js, Zustand, etc. even if the JD is vague.
      // ─────────────────────────────────────────────────────────────────────────
      const scratchPrompt = `
You are a world-class resume writer and ATS specialist writing for the year 2026.
Your task: build a COMPLETE, realistic, ATS-optimised professional resume for a candidate applying to the role described below. The candidate has no existing resume — invent all content.

═══════════════════════════════════════════
TARGET ROLE
  Job Title : ${resolvedJobTitle || "(infer from JD below)"}
  Company   : ${resolvedCompany || "(not specified)"}
${hasJD ? `\nJob Description:\n${jdFull}` : ""}

═══════════════════════════════════════════
STEP 1 — DETERMINE THE IDEAL 2026 TECH STACK FOR THIS ROLE
  • Based on the job title (and JD if provided), select the tech stack that top engineers in this exact role use in 2026.
  • If a JD is provided, treat it as the PRIMARY source — use its required and preferred tech.
  • If no JD, use current industry-standard tools for the title (e.g. "Senior React Engineer" → React 18, TypeScript, Next.js 14, Zustand, React Query, Vite, Vitest, Tailwind CSS, Node.js, PostgreSQL, Docker, GitHub Actions).
  • Populate ALL four skill categories: languages, frameworks, databases, tools/infra.

STEP 2 — CRAFT EACH RESUME SECTION
  role       → exact job title
  location   → "Remote" or a major tech hub city relevant to the company/role
  summary    → 3–4 sentences: "X+ years", 5–6 core tech skills from STEP 1, mention company name if provided, relevant domain (fintech / SaaS / platform / etc.)
  experience → 2–3 past positions that PROVE the candidate is qualified:
               • Total timeline = required years (default 5–6 if not specified)
               • Format EXACTLY:
                   Company Name | Job Title | Month Year – Month Year
                   • Bullet with metric/achievement using stack from STEP 1
                   • Bullet with metric/achievement
                   • Bullet with metric/achievement
               • Company names: realistic mid-to-large companies (NOT the hiring company)
               • Bullet style: action verb + outcome + technology (e.g. "Reduced API latency 40% by migrating to Redis caching")
  skills     → use the stack from STEP 1 — every item MUST be relevant to the role
  projects   → 2 portfolio projects using stack from STEP 1, each with a measurable outcome
  education  → Bachelor's or Master's in Computer Science / Software Engineering from a realistic university

LOCKED — NEVER change these:
  name : ${currentFields.name ?? ""}
  email: ${currentFields.email ?? ""}

═══════════════════════════════════════════
Return ONLY a JSON object — no markdown, no extra text:
{
  "tailoredFields": {
    "role": "...",
    "location": "...",
    "summary": "...",
    "experience": "Company Name | Job Title | Month Year – Month Year\\n• Achievement bullet with metric and tech\\n• Achievement bullet with metric\\n• Achievement bullet\\n\\nCompany Name 2 | Job Title 2 | Month Year – Month Year\\n• Achievement bullet\\n• Achievement bullet",
    "skillsLanguages": "Comma-separated languages",
    "skillsFrameworks": "Comma-separated frameworks & libraries",
    "skillsDatabases": "Comma-separated databases, caches, queues",
    "skillsTools": "Comma-separated DevOps, cloud, CI/CD, monitoring tools",
    "projects": "Project Name\\n• What it does and the outcome\\n• Technologies: list from STEP 1 stack\\n\\nProject Name 2\\n• What it does\\n• Technologies: list from STEP 1 stack",
    "education": "Degree Name\\nUniversity Name\\nGraduation Year"
  },
  "keywordsMatched": ["keyword1", "keyword2"],
  "keywordsMissing": [],
  "matchScore": 95
}
      `.trim();

      // ─────────────────────────────────────────────────────────────────────────
      // EXPERIENCE GUARD — parse source experience into locked headers + bullets
      //
      // The AI is not permitted to invent employers, titles, or dates.
      // We parse the source experience into structured blocks, pass only the
      // header lines to the model as immutable anchors, and after the model
      // responds we deterministically verify (and if needed restore) them.
      // ─────────────────────────────────────────────────────────────────────────

      /**
       * Represents one parsed experience block from the source resume.
       * header  — the "Company | Title | Dates" or "Company\nTitle\nDates" line(s)
       * bullets — the editable bullet lines beneath that header
       */
      interface ExpBlock {
        header: string;   // verbatim — locked
        bullets: string;  // rewriteable
      }

      /**
       * Split raw experience text into blocks.
       * Handles both common formats:
       *   Format A: "Company | Title | Dates\n• bullet\n\nCompany2 | …"
       *   Format B: "Company\nTitle\nDates\n• bullet\n\nCompany2\n…"
       * Returns [] when experience is empty or unparseable.
       */
      function parseExperienceBlocks(raw: string): ExpBlock[] {
        if (!raw || !raw.trim()) return [];
        const blocks = raw.trim().split(/\n\s*\n/);
        return blocks
          .map((block) => {
            const lines = block.trim().split("\n");
            const headerLines: string[] = [];
            const bulletLines: string[] = [];
            for (const line of lines) {
              if (line.trimStart().startsWith("•") || line.trimStart().startsWith("-") || line.trimStart().startsWith("*")) {
                bulletLines.push(line);
              } else {
                // Non-bullet lines before first bullet are the header
                if (bulletLines.length === 0) {
                  headerLines.push(line);
                } else {
                  // Non-bullet after bullet = start of next block? Keep as bullet continuation.
                  bulletLines.push(line);
                }
              }
            }
            return {
              header: headerLines.join("\n").trim(),
              bullets: bulletLines.join("\n").trim(),
            };
          })
          .filter((b) => b.header.length > 0);
      }

      /**
       * Rebuild a full experience string from blocks, preserving blank-line separation.
       */
      function rebuildExperience(blocks: ExpBlock[]): string {
        return blocks.map((b) => (b.bullets ? `${b.header}\n${b.bullets}` : b.header)).join("\n\n");
      }

      /**
       * Extract just the header tokens from an experience block header string.
       * Normalises whitespace and lowercases for comparison.
       */
      function headerTokens(header: string): string[] {
        return header
          .toLowerCase()
          .split(/[\|\n,–\-]+/)
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
      }

      /**
       * Given source blocks and AI-returned experience text, validate and restore.
       *
       * Strategy:
       *  1. Parse the AI output into blocks.
       *  2. For each source block, find the best-matching AI block by header similarity.
       *  3. If match found → replace AI header with source header (locked), keep AI bullets.
       *  4. If no match found for a source block → keep source header + source bullets (fallback).
       *  5. Discard any AI blocks that don't correspond to a source block (invented employers).
       *
       * Returns { experience, headersFabricated } where headersFabricated=true means
       * the guard had to intervene.
       */
      function validateAndRestoreExperience(
        sourceBlocks: ExpBlock[],
        aiExperience: string,
      ): { experience: string; headersFabricated: boolean } {
        if (sourceBlocks.length === 0) {
          // No source blocks to validate against — trust the AI output.
          return { experience: aiExperience, headersFabricated: false };
        }

        const aiBlocks = parseExperienceBlocks(aiExperience);
        let fabricated = false;

        const mergedBlocks: ExpBlock[] = sourceBlocks.map((src) => {
          const srcTokens = headerTokens(src.header);

          // Score each AI block by how many header tokens it shares with the source block.
          let bestBlock: ExpBlock | null = null;
          let bestScore = 0;
          for (const ai of aiBlocks) {
            const aiTokens = headerTokens(ai.header);
            const shared = srcTokens.filter((t) =>
              aiTokens.some((at) => at.includes(t) || t.includes(at)),
            ).length;
            const score = shared / Math.max(srcTokens.length, 1);
            if (score > bestScore) {
              bestScore = score;
              bestBlock = ai;
            }
          }

          // Threshold: must share at least 40% of header tokens to be considered a match.
          if (bestBlock && bestScore >= 0.4) {
            if (bestBlock.header.trim() !== src.header.trim()) {
              fabricated = true;
              console.warn(
                "[resume.tailor] ⚠ header mismatch — restoring source header",
                { source: src.header.trim(), ai: bestBlock.header.trim(), score: bestScore },
              );
            }
            return { header: src.header, bullets: bestBlock.bullets };
          }

          // No match: AI removed or completely renamed this job — fall back to source.
          fabricated = true;
          console.warn(
            "[resume.tailor] ⚠ no AI match for source block — using source fallback",
            { source: src.header.trim() },
          );
          return { header: src.header, bullets: src.bullets };
        });

        return { experience: rebuildExperience(mergedBlocks), headersFabricated: fabricated };
      }

      // ── Parse source experience now, before calling the model ──────────────
      const sourceExpBlocks = parseExperienceBlocks(currentFields.experience ?? "");
      const sourceHeadersText = sourceExpBlocks.map((b) => b.header).join("\n---\n");

      console.log("[resume.tailor] source experience headers:", sourceExpBlocks.map((b) => b.header));

      // ─────────────────────────────────────────────────────────────────────────
      // EXISTING RESUME — TRUTH-PRESERVING REWRITE ENGINE
      //
      // PRD alignment: Scribeshade rewrites editable content for the target JD,
      // but NEVER fabricates work history. Employers, job titles, and dates are
      // immutable facts — only bullet wording may change.
      // ─────────────────────────────────────────────────────────────────────────

      const systemMessage = `
You are Scribeshade's "Truth-Preserving Rewrite Engine" for JD-specific resume tailoring.

TARGET ROLE: ${resolvedJobTitle || "(see JD below)"}${resolvedCompany ? ` at ${resolvedCompany}` : ""}

════════════════════════════════════════════════════════════
ABSOLUTE RULE — FACTUAL FIELDS ARE NEVER A REWRITE ZONE
════════════════════════════════════════════════════════════

WORK EXPERIENCE:
  • You may ONLY rewrite the bullet text (lines starting with "•") under each job.
  • You MUST preserve every company name, job title, and date range EXACTLY as given.
  • You MUST NOT create new employers, new titles, or new date ranges.
  • You MUST NOT output any experience block whose header line is not in the SOURCE HEADERS below.
  • Do NOT replace a real employer with a famous tech company (Google, Spotify, Netflix, Uber, etc.).

EDUCATION — FACTUAL HISTORY, NOT A REWRITE ZONE:
  • If institution name, degree, GPA, or education dates are present in the uploaded resume,
    copy them EXACTLY. Do not modify, replace, upgrade, or fabricate them.
  • Do not change BCA to B.Tech, B.S., M.S., or any other degree.
  • Do not change "Mohanlal Sukhadia University" to "University of California" or any other school.
  • Do not add GPA, honors, or coursework if not present in the source.
  • If education is missing from the source resume, leave "education" as an empty string — never invent it.

CERTIFICATIONS:
  • Copy the entire certifications field verbatim from the source. Do not alter issuer names or dates.

PERSONAL INFO:
  • name, email, phone, location — copy verbatim from source. Never alter.

SOURCE EXPERIENCE HEADERS (copy these verbatim into your output — do not alter a single character):
${sourceHeadersText || "(no experience provided)"}

WHAT YOU MAY REWRITE:
  • "role"     — set to EXACT target job title
  • "summary"  — 3–4 sentences targeting the applied role; open with target-role identity
  • Bullet lines under each existing job (ONLY the "•" lines, NOT the header)
  • "skillsLanguages", "skillsFrameworks", "skillsDatabases", "skillsTools"
  • Project descriptions (project names stay verbatim)

ABSOLUTE OUTPUT RULES:
  1. Output ONLY a single JSON object. No prose, no markdown fences.
  2. "role" MUST equal "${resolvedJobTitle || "the target job title from the JD"}".
  3. Experience headers MUST match SOURCE EXPERIENCE HEADERS exactly.
  4. "education" MUST equal the source education exactly (or empty string if source was empty).
  5. Do NOT invent companies, titles, dates, degrees, universities, or certifications.
  6. "summary" must NOT mention the candidate's old domain as their identity.
      `.trim();

      const userPrompt = `
═══════════════════════════════════════════════════════════════════
TRUTH-PRESERVING REWRITE MODE — ACTIVE

PRIMARY SOURCE OF TRUTH (priority order):
  1. Target Job Title : ${resolvedJobTitle || "(extract from JD — first line that names the role)"}
  2. Target Company   : ${resolvedCompany || "(extract from JD)"}
  3. Job Description${hasJD ? `:\n\n--- JOB DESCRIPTION ---\n${jdFull}\n--- END JOB DESCRIPTION ---` : " : NOT PROVIDED — rely on title alone"}

═══════════════════════════════════════════════════════════════════
LOCKED FACTS — COPY THESE VERBATIM, DO NOT ALTER A SINGLE CHARACTER

EXPERIENCE HEADERS (company name, job title, dates — locked):
${sourceHeadersText || "(none)"}

  • Never create a new company, title, or date range.
  • Never replace a real employer with a famous tech company (Google, Spotify, Netflix, Uber, etc.).
  • Never change the number of jobs or their chronological order.
  • Treat these headers as constants — paste them back unchanged in your output.

EDUCATION — LOCKED FACTUAL HISTORY:
${currentFields.education?.trim() ? `Source education (copy this EXACTLY — do not alter a single word, date, degree name, or institution name):\n${currentFields.education.trim()}` : "Source education: (empty — do NOT invent any education block; leave 'education' as empty string \"\")"}

  • Do not upgrade the degree (BCA stays BCA, not B.Tech or M.S.).
  • Do not change the institution name to a more prestigious school.
  • Do not add GPA, honors, coursework, or dates that were not in the source.
  • If source education is empty, output "education": "" — never invent an institution.

CERTIFICATIONS — LOCKED:
${currentFields.certifications?.trim() ? `Source certifications (copy verbatim):\n${currentFields.certifications.trim()}` : "Source certifications: (empty — output \"certifications\": \"\")"}

Personal: name="${currentFields.name ?? ""}", email="${currentFields.email ?? ""}",
          phone="${currentFields.phone ?? ""}", location="${currentFields.location ?? ""}"

═══════════════════════════════════════════════════════════════════
WHAT YOU MUST REWRITE (editable fields — transform for the target role)

  ▸ role     — set to EXACT target job title
  ▸ summary  — 3–4 sentence profile for a ${resolvedJobTitle || "target-role"} professional.
               Open with the target-role identity. Reference company/domain if provided.
               Mention 4–6 core 2026 technologies for this role.
               DO NOT say "transitioning from" or name the old domain.
  ▸ experience BULLETS ONLY — for each locked job above, rewrite the bullet lines:
               • Use target-role vocabulary, tools, verbs, and success metrics.
               • Reframe the candidate's real work toward the closest analogous
                 target-role activity (e.g. building a mobile sync layer → designing
                 a CDC pipeline / streaming ingestion system).
               • Preserve any real metrics from the source; never invent new numbers.
               • 3–5 bullets per position. ≥60% of bullets must name a target-stack tool.
               • DO NOT keep old-domain jargon with no target-role analogue.
  ▸ skills   — replace all four fields with the ideal 2026 stack for the target role.
               Include every tech in the JD plus the broader modern stack.
  ▸ projects — project NAMES are locked. Rewrite every description for target-role relevance.
  ▸ certifications — issuer + date locked; rewrite description toward target role.
  ▸ education — copy verbatim.

═══════════════════════════════════════════════════════════════════
EXPERIENCE FORMAT RULES

  Detect the header format from the source:
    Format A: "Company | Title | Dates"  (pipe-separated single line)
    Format B: "Company\\nTitle\\nDates"   (separate lines)
  Use the same format in your output.
  Header lines: PASTE VERBATIM (exactly as shown in SOURCE EXPERIENCE HEADERS above).
  Bullet lines: replace with new target-role bullets starting with "•".
  Preserve blank lines between job blocks.

═══════════════════════════════════════════════════════════════════
CONCRETE EXAMPLE

  LOCKED HEADERS (from source resume):
    WebSenor | React Developer | Jun 2022 – Dec 2023
    MyPay Communication | MERN Developer | Jan 2024 – Present

  TARGET ROLE: Data Engineer

  WRONG — NEVER DO THIS (invented employers):
    Spotify | Data Engineer | 2022 – 2023
    Uber | Senior Data Engineer | 2023 – Present

  CORRECT:
    WebSenor | React Developer | Jun 2022 – Dec 2023
    • Designed event-driven ingestion pipeline processing 20K+ daily user events
      into a partitioned data lake on S3, enabling downstream Spark aggregation jobs.
    • Built CDC-style sync layer (React Native + SQLite + Postgres) — same idempotency
      patterns applied to Kafka consumer groups for exactly-once delivery.
    • Reduced dashboard query latency 35% by introducing Redis caching on hot
      analytics endpoints; later ported the pattern to a materialized view in Snowflake.

    MyPay Communication | MERN Developer | Jan 2024 – Present
    • Instrumented transaction event streams using Kafka producers, enabling
      real-time payment reconciliation across distributed microservices.
    • Modelled transactional data in PostgreSQL with a star-schema design;
      wrote dbt models to populate a BI-ready data mart for finance reporting.

  Note: company names and dates are unchanged. Only bullets are new.

═══════════════════════════════════════════════════════════════════
SELF-CHECK BEFORE RETURNING — every box MUST be true:
  □ "role" equals the target job title.
  □ "summary" opens with the target-role identity. Old domain not mentioned.
  □ Every experience header matches the SOURCE EXPERIENCE HEADERS exactly.
  □ No new company or title appears in "experience" that was not in the source.
  □ ≥60% of experience bullets contain a target-stack tool name.
  □ All four "skills*" fields replaced with target 2026 stack.
  □ Project names are unchanged; descriptions are rewritten.
  □ "education" exactly matches the SOURCE EDUCATION above (or empty string if source was empty).
  □ "certifications" exactly matches the SOURCE CERTIFICATIONS above (or empty string if source was empty).
If any box fails — REWRITE before responding.

═══════════════════════════════════════════════════════════════════
EXISTING RESUME (factual context — extract facts, then transform editable sections):

${JSON.stringify(
  {
    name:             currentFields.name,
    role:             currentFields.role,
    location:         currentFields.location,
    summary:          currentFields.summary,
    experience:       currentFields.experience,
    skillsLanguages:  currentFields.skillsLanguages,
    skillsFrameworks: currentFields.skillsFrameworks,
    skillsDatabases:  currentFields.skillsDatabases,
    skillsTools:      currentFields.skillsTools,
    projects:         currentFields.projects,
    education:        currentFields.education,
    certifications:   currentFields.certifications,
  },
  null,
  2,
)}

═══════════════════════════════════════════════════════════════════
RETURN ONLY THIS JSON — nothing else:
{
  "tailoredFields": {
    "role": "exact target job title",
    "summary": "fully rewritten target-role profile, 3-4 sentences",
    "experience": "VERBATIM header line 1\\n• rewritten bullet\\n• rewritten bullet\\n\\nVERBATIM header line 2\\n• rewritten bullet\\n• rewritten bullet",
    "skillsLanguages": "target 2026 languages",
    "skillsFrameworks": "target 2026 frameworks/libs",
    "skillsDatabases": "target 2026 databases/warehouses",
    "skillsTools": "target 2026 DevOps/cloud/orchestration",
    "projects": "VERBATIM Project Name\\n• Rewritten in target-role language\\n• Tech: target stack\\n\\nVERBATIM Project Name 2\\n• Rewritten",
    "education": "COPY SOURCE EDUCATION VERBATIM (or empty string if source was empty)",
    "certifications": "COPY SOURCE CERTIFICATIONS VERBATIM (or empty string if source was empty)"
  },
  "keywordsMatched": ["target-stack-keyword-from-jd", "..."],
  "keywordsMissing": ["jd-keyword-not-fittable", "..."],
  "matchScore": 88
}
      `.trim();

      const useSystemMessages = !isManual;
      const messages = useSystemMessages
        ? [
            { role: "system" as const, content: systemMessage },
            { role: "user"   as const, content: userPrompt },
          ]
        : [{ role: "user" as const, content: scratchPrompt }];

      // Diagnostics: confirm exactly what we're sending to the model so we can
      // verify the system message + JD + target role are reaching the LLM.
      console.log("[resume.tailor] →", {
        model: TAILOR_MODEL,
        path: useSystemMessages ? "existing-resume" : "scratch",
        jobTitle,
        company,
        jdChars: jobDescription.length,
        hasJD,
        messageRoles: messages.map((m) => m.role),
        systemChars: useSystemMessages ? systemMessage.length : 0,
        userChars: useSystemMessages ? userPrompt.length : scratchPrompt.length,
      });

      const response = await ai.chat.send({
        chatRequest: {
          model: TAILOR_MODEL,
          messages,
          // Slightly higher temperature so the rewrite is genuinely fresh prose,
          // not a near-copy of the input bullets. The strict prompt + self-check
          // keep factual integrity intact.
          temperature: 0.7,
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

      // ══════════════════════════════════════════════════════════════════════
      // POST-AI LOCKED-FIELD GUARD
      // Deterministically restores all factual fields that must never be
      // fabricated by the model, regardless of what the prompt said.
      //
      // Fields guarded here:
      //   • education          — institution, degree, dates — never invent
      //   • certifications     — issuer + dates — never invent (desc is ok)
      //   • name/email/phone/location — always locked
      //   • experience headers — handled by validateAndRestoreExperience below
      // ══════════════════════════════════════════════════════════════════════

      const lockedFieldLog: Record<string, { source: string; ai: string }> = {};

      /**
       * Hard-lock a single string field: if source has a value, AI output
       * must match it exactly. If source is empty, discard AI output.
       */
      function guardLockedField(
        fieldName: keyof ResumeFields,
        sourceValue: string | null | undefined,
      ): void {
        const aiValue = (parsed!.tailoredFields as Record<string, string>)[fieldName as string] ?? "";
        const src     = (sourceValue ?? "").trim();

        if (src.length > 0) {
          // Source has value — AI must not change it
          if (aiValue.trim() !== src) {
            lockedFieldLog[fieldName as string] = { source: src, ai: aiValue };
            (parsed!.tailoredFields as Record<string, string>)[fieldName as string] = src;
          }
        } else {
          // Source is empty — AI must not fabricate
          if (aiValue.trim().length > 0) {
            lockedFieldLog[fieldName as string] = { source: "(empty)", ai: aiValue };
            (parsed!.tailoredFields as Record<string, string>)[fieldName as string] = "";
          }
        }
      }

      // ── Education guard ───────────────────────────────────────────────────
      // Education is entirely factual. If source has it, copy it verbatim.
      // If source is empty, AI must not invent it.
      guardLockedField("education", currentFields.education);

      // ── Personal facts guard ──────────────────────────────────────────────
      guardLockedField("name",     currentFields.name);
      guardLockedField("email",    currentFields.email);
      guardLockedField("phone",    currentFields.phone);
      guardLockedField("location", currentFields.location);

      // ── Certifications: preserve issuer+dates by restoring original when source exists ─
      // The full certs string contains issuer+dates (factual) mixed with description
      // (editable). For safety, if source has certs, keep the whole source value.
      // The model is allowed to rewrite descriptions only when we can parse them —
      // for now the safe default is to lock the whole field.
      guardLockedField("certifications", currentFields.certifications);

      if (Object.keys(lockedFieldLog).length > 0) {
        console.warn("[resume.tailor] ⚠ locked-field fabrication detected — reverted:", lockedFieldLog);
      } else {
        console.log("[resume.tailor] ✅ locked fields passed validation");
      }

      // ── Experience header guard ───────────────────────────────────────────
      if (sourceExpBlocks.length > 0 && parsed.tailoredFields?.experience) {
        const aiExp = parsed.tailoredFields.experience as string;
        const { experience: guardedExp, headersFabricated } =
          validateAndRestoreExperience(sourceExpBlocks, aiExp);

        console.log("[resume.tailor] experience guard:", {
          sourceBlocks: sourceExpBlocks.length,
          headersFabricated,
          sourceHeaders: sourceExpBlocks.map((b) => b.header),
        });

        parsed.tailoredFields.experience = guardedExp;
      }
      // / experience are nearly identical to the originals, the model is
      // ignoring the rewrite directive and we should escalate the prompt or
      // switch to a stronger model.
      const sameSummary    = (parsed.tailoredFields?.summary ?? "").trim() === (currentFields.summary ?? "").trim();
      const sameExperience = (parsed.tailoredFields?.experience ?? "").trim() === (currentFields.experience ?? "").trim();
      const sameSkillsLang = (parsed.tailoredFields?.skillsLanguages ?? "").trim() === (currentFields.skillsLanguages ?? "").trim();
      console.log("[resume.tailor] ←", {
        model: TAILOR_MODEL,
        responseChars: aiText.length,
        rewroteSummary:    !sameSummary,
        rewroteExperience: !sameExperience,
        rewroteSkillsLang: !sameSkillsLang,
        newRole: parsed.tailoredFields?.role,
        matchScore: parsed.matchScore,
        keywordsMatched: parsed.keywordsMatched?.length ?? 0,
      });

      return {
        tailoredFields: parsed.tailoredFields ?? {},
        keywordsMatched: parsed.keywordsMatched ?? [],
        keywordsMissing: parsed.keywordsMissing ?? [],
        matchScore: parsed.matchScore ?? 0,
        _aiUsage: { aiModel: TAILOR_MODEL },
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

  const result: BuilderAtsResult = {
    score: parsed.score,
    grade: parsed.grade ?? deriveAtsGrade(parsed.score),
    summary: parsed.summary ?? "",
    strengths: parsed.strengths ?? [],
    weaknesses: parsed.weaknesses ?? [],
    missingKeywords: parsed.missingKeywords ?? [],
    suggestions: parsed.suggestions ?? [],
    sectionScores: parsed.sectionScores ?? {},
  };

  // Persist the score so the resume list can display it, and persist full result for the editor panel
  await prisma.builtResume.update({
    where: { id: resumeId },
    data: {
      atsScore: result.score,
      lastAtsResult: result as unknown as Prisma.JsonObject,
      lastAtsAt: new Date(),
    },
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI — Full Resume Rewrite (role-based, no JD required)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rewrites all editable resume sections to target a specific role and company.
 * Unlike JD Tailor, no job description is required — the AI uses role context
 * and 2026 industry standards to craft compelling, ATS-optimised content.
 *
 * Locked fields (name, email, employer names, dates) are never altered.
 * Cost: 4 credits (same pool as tailor, resolved from FeatureCost).
 */
export async function rewriteResume(input: RewriteResumeInput): Promise<{
  tailoredFields: Partial<ResumeFields>;
  creditsUsed: number;
  creditsRemaining: number;
  cached: boolean;
}> {
  const { userId, resumeId, jobTitle, company, targetLevel } = input;

  let currentFields: Partial<ResumeFields> = {};
  let resolvedResumeId: string | undefined;

  if (resumeId) {
    const resume = await prisma.builtResume.findFirst({
      where: { id: resumeId, userId: { not: undefined } },
    });
    if (!resume) throw new AppError(404, "Resume not found");
    currentFields = resume.fields as unknown as ResumeFields;
    resolvedResumeId = resumeId;
  } else {
    currentFields = (input.fields ?? {}) as Partial<ResumeFields>;
  }

  const cost = await getFeatureCost(RESUME_FEATURE_KEYS.REWRITE, new Prisma.Decimal("4"));
  const cacheKey = hashInput("rewrite_v1", jobTitle, company ?? "", targetLevel ?? "");

  const { result, creditsUsed, creditsRemaining, cached } = await withCreditedAiAction<{
    tailoredFields: Partial<ResumeFields>;
  }>(
    {
      userId,
      operation: "RESUME_REWRITE",
      cost,
      idempotencyKey: input.idempotencyKey,
      resumeId: resolvedResumeId,
      cacheKey,
      metadata: { jobTitle, company },
    },
    async () => {
      const levelHint = targetLevel ? `Seniority: ${targetLevel}. ` : "";
      const companyHint = company ? `\nTarget company: ${company}.` : "";

      const prompt = `
You are a world-class resume writer. Rewrite the following resume sections to be highly compelling for a ${jobTitle} role.${companyHint}
${levelHint}

IMPORTANT RULES:
- NEVER change: name, email, employer names/companies, job titles, dates, degrees, institutions
- Rewrite: summary, experience bullet points (same structure), skills, project descriptions
- Use strong action verbs, quantified outcomes, and ATS-friendly keywords for a ${jobTitle}
- Return ONLY a JSON object — no markdown, no extra text

Current resume content:
${JSON.stringify(currentFields, null, 2).substring(0, 4000)}

Return JSON:
{
  "tailoredFields": {
    "summary": "...",
    "experience": "...",
    "skillsLanguages": "...",
    "skillsFrameworks": "...",
    "skillsDatabases": "...",
    "skillsTools": "...",
    "projects": "..."
  }
}
      `.trim();

      const response = await ai.chat.send({
        chatRequest: {
          model: TAILOR_MODEL,
          messages: [{ role: "user", content: prompt }],
        },
      });

      const aiText = response.choices[0]?.message?.content ?? "";
      const parsed = parseJsonResponse<{ tailoredFields: Partial<ResumeFields> }>(aiText);
      if (!parsed?.tailoredFields) {
        throw new AppError(502, "AI returned an unparseable rewrite response");
      }

      // Guard: never overwrite name/email even if AI ignores instructions
      delete (parsed.tailoredFields as Record<string, unknown>).name;
      delete (parsed.tailoredFields as Record<string, unknown>).email;

      return {
        tailoredFields: parsed.tailoredFields,
        _aiUsage: { aiModel: TAILOR_MODEL },
      };
    },
  );

  return { tailoredFields: result.tailoredFields, creditsUsed, creditsRemaining, cached };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI — Inject Skills
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyses the current resume skills + job description, then returns an updated
 * set of skills fields that adds role-relevant skills the candidate is missing.
 * Existing skills are preserved and deduplicated.
 *
 * Cost: 1 credit (resolved from FeatureCost `resume_inject_skills`).
 */
export async function injectSkills(input: InjectSkillsInput): Promise<{
  injectedFields: Partial<ResumeFields>;
  suggestedSkills: string[];
  creditsUsed: number;
  creditsRemaining: number;
  cached: boolean;
}> {
  const { userId, jobDescription, jobTitle, fields } = input;

  const cost = await getFeatureCost(RESUME_FEATURE_KEYS.INJECT_SKILLS, new Prisma.Decimal("1"));
  const cacheKey = hashInput("inject_skills_v1", jobTitle ?? "", (jobDescription ?? "").substring(0, 500), fields.skillsLanguages ?? "", fields.skillsFrameworks ?? "");

  const { result, creditsUsed, creditsRemaining, cached } = await withCreditedAiAction<{
    injectedFields: Partial<ResumeFields>;
    suggestedSkills: string[];
  }>(
    {
      userId,
      operation: "RESUME_INJECT_SKILLS",
      cost,
      idempotencyKey: input.idempotencyKey,
      resumeId: input.resumeId,
      cacheKey,
      metadata: { jobTitle },
    },
    async () => {
      const existingSkills = [
        fields.skillsLanguages ?? "",
        fields.skillsFrameworks ?? "",
        fields.skillsDatabases ?? "",
        fields.skillsTools ?? "",
      ].filter(Boolean).join(", ");

      const prompt = `
You are a technical resume expert. Based on the target role and job description, identify skills that are missing from this candidate's resume and should be added.

${jobTitle ? `Target role: ${jobTitle}` : ""}
${jobDescription ? `Job Description:\n${jobDescription.substring(0, 2000)}` : ""}

Existing skills: ${existingSkills || "(none listed)"}

Instructions:
- Only add skills that are GENUINELY relevant to the role and NOT already listed
- Distribute added skills across the four categories below (languages, frameworks, databases, tools)
- Preserve all existing skills — merge new ones in comma-separated format
- Do not add soft skills, do not invent skills the candidate cannot plausibly have
- Return ONLY valid JSON, no markdown

Return JSON:
{
  "injectedFields": {
    "skillsLanguages": "<existing + new, comma-separated>",
    "skillsFrameworks": "<existing + new, comma-separated>",
    "skillsDatabases": "<existing + new, comma-separated>",
    "skillsTools": "<existing + new, comma-separated>"
  },
  "suggestedSkills": ["skill1", "skill2", "...(only the NEW ones added)"]
}
      `.trim();

      const response = await ai.chat.send({
        chatRequest: {
          model: OPENROUTER_MODEL,
          messages: [{ role: "user", content: prompt }],
        },
      });

      const aiText = response.choices[0]?.message?.content ?? "";
      const parsed = parseJsonResponse<{ injectedFields: Partial<ResumeFields>; suggestedSkills: string[] }>(aiText);
      if (!parsed?.injectedFields) {
        throw new AppError(502, "AI returned an unparseable skill injection response");
      }

      return {
        injectedFields: parsed.injectedFields,
        suggestedSkills: parsed.suggestedSkills ?? [],
        _aiUsage: { aiModel: OPENROUTER_MODEL },
      };
    },
  );

  return {
    injectedFields: result.injectedFields,
    suggestedSkills: result.suggestedSkills,
    creditsUsed,
    creditsRemaining,
    cached,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI — Inject Keywords (bulk keyword injection into resume sections)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts important keywords from the job description that are missing from the
 * resume, then weaves them naturally into the summary, experience, and projects
 * sections without altering facts or structure.
 *
 * Cost: 2 credits (resolved from FeatureCost `resume_inject_keywords`).
 */
export async function injectKeywords(input: InjectKeywordsInput): Promise<{
  injectedFields: Partial<ResumeFields>;
  injectedKeywords: string[];
  creditsUsed: number;
  creditsRemaining: number;
  cached: boolean;
}> {
  const { userId, jobDescription, fields } = input;

  const cost = await getFeatureCost(RESUME_FEATURE_KEYS.INJECT_KEYWORDS, new Prisma.Decimal("2"));
  const cacheKey = hashInput("inject_keywords_v1", jobDescription.substring(0, 500), fields.summary ?? "", fields.experience?.substring(0, 200) ?? "");

  const { result, creditsUsed, creditsRemaining, cached } = await withCreditedAiAction<{
    injectedFields: Partial<ResumeFields>;
    injectedKeywords: string[];
  }>(
    {
      userId,
      operation: "RESUME_INJECT_KEYWORDS",
      cost,
      idempotencyKey: input.idempotencyKey,
      resumeId: input.resumeId,
      cacheKey,
      metadata: {},
    },
    async () => {
      const prompt = `
You are an ATS expert. Your job is to inject missing job-description keywords naturally into a candidate's resume — without inventing facts, changing job titles, or altering employer names/dates.

Job Description:
${jobDescription.substring(0, 3000)}

Current resume sections:
summary: ${fields.summary ?? ""}
experience: ${(fields.experience ?? "").substring(0, 1500)}
projects: ${(fields.projects ?? "").substring(0, 800)}

Instructions:
- Extract the top 10-15 ATS keywords from the JD that are ABSENT from the resume
- Weave them naturally into the summary, experience bullets, and project descriptions
- NEVER: invent employers, change dates, change job titles, or add bullet points that describe things the candidate never did
- Return ONLY valid JSON, no markdown

Return JSON:
{
  "injectedFields": {
    "summary": "<rewritten summary with keywords woven in>",
    "experience": "<rewritten experience with keywords woven into bullets>",
    "projects": "<rewritten projects with keywords>"
  },
  "injectedKeywords": ["keyword1", "keyword2", "..."]
}
      `.trim();

      const response = await ai.chat.send({
        chatRequest: {
          model: TAILOR_MODEL,
          messages: [{ role: "user", content: prompt }],
        },
      });

      const aiText = response.choices[0]?.message?.content ?? "";
      const parsed = parseJsonResponse<{ injectedFields: Partial<ResumeFields>; injectedKeywords: string[] }>(aiText);
      if (!parsed?.injectedFields) {
        throw new AppError(502, "AI returned an unparseable keyword injection response");
      }

      return {
        injectedFields: parsed.injectedFields,
        injectedKeywords: parsed.injectedKeywords ?? [],
        _aiUsage: { aiModel: TAILOR_MODEL },
      };
    },
  );

  return {
    injectedFields: result.injectedFields,
    injectedKeywords: result.injectedKeywords,
    creditsUsed,
    creditsRemaining,
    cached,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword Match (free — no AI, pure text analysis)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts keywords from a job description and checks which ones appear in the
 * resume. No AI model call, no credit charge — pure text analysis.
 *
 * Returns present keywords, missing keywords, and a coverage score (0–100).
 */
export function analyzeKeywordMatch(input: KeywordMatchInput): KeywordMatchResult {
  const { jobDescription, fields } = input;

  // Flatten all resume text into one searchable string (lowercase)
  const resumeText = Object.values(fields)
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();

  // Extract candidate keywords from JD:
  // 1. Split on whitespace/punctuation
  // 2. Filter: 3+ chars, not common stop words, not purely numeric
  const STOP_WORDS = new Set([
    "the", "and", "for", "are", "you", "will", "with", "our", "have", "that",
    "this", "from", "they", "been", "has", "not", "but", "can", "its", "was",
    "all", "one", "your", "who", "how", "out", "use", "any", "each", "about",
    "more", "also", "than", "into", "such", "work", "team", "role", "job",
    "skills", "experience", "looking", "join", "seek", "must", "able",
    "strong", "good", "great", "excellent", "preferred", "required",
  ]);

  const rawTokens = jobDescription
    .toLowerCase()
    .split(/[\s,;:\-–()\[\].!?/|+&]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));

  // Deduplicate while preserving order of first occurrence
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const t of rawTokens) {
    if (!seen.has(t)) {
      seen.add(t);
      keywords.push(t);
    }
  }

  // Cap at 60 most relevant keywords (first 60 from JD tend to be the most important)
  const topKeywords = keywords.slice(0, 60);

  const present: string[] = [];
  const missing: string[] = [];
  for (const kw of topKeywords) {
    if (resumeText.includes(kw)) {
      present.push(kw);
    } else {
      missing.push(kw);
    }
  }

  const matchScore = topKeywords.length > 0
    ? Math.round((present.length / topKeywords.length) * 100)
    : 0;

  return { present, missing, matchScore };
}
