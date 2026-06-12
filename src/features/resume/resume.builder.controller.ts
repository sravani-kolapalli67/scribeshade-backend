import { Request, Response, NextFunction } from "express";

import { getCurrentUserId } from "../auth/auth.middleware";
import { prisma } from "../../shared/lib/prisma";
import { AppError } from "../../shared/middleware/error.middleware";
import {
  saveBuiltResume,
  listBuiltResumes,
  getBuiltResume,
  deleteBuiltResume,
  renameBuiltResume,
  generateResumeHtml,
  enhanceSection,
  tailorResume,
  exportResumeHtml,
  extractFields,
  markBuiltResumeComplete,
  validateSection,
  scoreBuilderAts,
  rewriteResume,
  injectSkills,
  injectKeywords,
  analyzeKeywordsForInjection,
  analyzeKeywordMatch,
  PdfExportError,
  PDF_ERROR_CODES,
} from "./resume.builder.service";
import type {
  SaveBuiltResumeInput,
  GenerateResumeHtmlInput,
  EnhanceSectionInput,
  TailorResumeInput,
  ExportPdfInput,
  ExtractFieldsInput,
  ValidateSectionInput,
  RewriteResumeInput,
  InjectSkillsInput,
  InjectKeywordsInput,
  AnalyzeKeywordsInput,
  KeywordMatchInput,
} from "./resume.types";

async function resolveDbUserId(candidateUserId: string): Promise<string> {
  if (!candidateUserId) {
    throw new AppError(401, "Authenticated user id is missing");
  }

  if (!candidateUserId.startsWith("user_")) {
    return candidateUserId;
  }

  const user = await prisma.user.findUnique({
    where: { clerkId: candidateUserId },
    select: { id: true },
  });

  if (!user) {
    throw new AppError(401, "Authenticated user was not found in the database");
  }

  return user.id;
}

async function resolveAuthenticatedBuilderUserId(
  req: Request,
): Promise<string> {
  return resolveDbUserId(getCurrentUserId(req).trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /resume/builder/save
 * Creates or updates a built resume draft.
 */
export async function saveBuiltResumeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { resumeId, title, templateId, fields, sections, jobDescription, jobTitle, company } =
      req.body as Partial<SaveBuiltResumeInput>;
    const userId = await resolveAuthenticatedBuilderUserId(req);

    if (!title || !templateId || !fields || !sections) {
      res
        .status(400)
        .json({ error: "title, templateId, fields and sections are required" });
      return;
    }

    const result = await saveBuiltResume({
      userId,
      resumeId: resumeId ?? null,
      title,
      templateId,
      fields,
      sections,
      jobDescription,
      jobTitle,
      company,
    });

    const statusCode = resumeId ? 200 : 201;
    res.status(statusCode).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /resume/builder/list?userId=<id>
 * Lists all built resumes for the authenticated user.
 */
export async function listBuiltResumesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = await resolveAuthenticatedBuilderUserId(req);

    const resumes = await listBuiltResumes(userId);
    res.json({ resumes });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /resume/builder/:id
 * Returns a single built resume (all fields, for editor re-open).
 */
export async function getBuiltResumeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const userId = await resolveAuthenticatedBuilderUserId(req);
    const resume = await getBuiltResume(String(id), userId);
    res.json(resume);
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /resume/builder/:id
 * Deletes a built resume.
 */
export async function deleteBuiltResumeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const userId = await resolveAuthenticatedBuilderUserId(req);
    await deleteBuiltResume(String(id), userId);
    res.json({ message: "Built resume deleted successfully" });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /resume/builder/generate
 * AI-populates a template with the user's fields. Costs 1 credit.
 */
export async function generateResumeHtmlHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { templateCode, fields, jobDescription, jobTitle, company } =
      req.body as Partial<GenerateResumeHtmlInput>;
    const userId = await resolveAuthenticatedBuilderUserId(req);

    if (!templateCode || !fields) {
      res.status(400).json({ error: "templateCode and fields are required" });
      return;
    }

    const result = await generateResumeHtml({
      userId,
      templateCode,
      fields,
      jobDescription,
      jobTitle,
      company,
      idempotencyKey: req.idempotencyKey ?? null,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /resume/builder/enhance-section
 * AI-rewrites a single resume section. Costs 0.5 credits.
 */
export async function enhanceSectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const {
      sectionId,
      currentText,
      jobDescription,
      jobTitle,
      resumeContext,
      qualityIssues,
      qualitySuggestions,
    } =
      req.body as Partial<EnhanceSectionInput>;

    const userId = await resolveAuthenticatedBuilderUserId(req);

    if (!sectionId || !currentText) {
      res.status(400).json({ error: "sectionId and currentText are required" });
      return;
    }

    const result = await enhanceSection({
      userId,
      sectionId,
      currentText,
      jobDescription,
      jobTitle,
      resumeContext,
      qualityIssues,
      qualitySuggestions,
      idempotencyKey: req.idempotencyKey ?? null,
      resumeId: (req.body as { resumeId?: string }).resumeId ?? null,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /resume/builder/tailor
 * AI-tailors all resume sections to a target job description. Costs 1 credit.
 */
export async function tailorResumeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { resumeId, jobDescription, jobTitle, company, fields } =
      req.body as Partial<TailorResumeInput>;
    const userId = await resolveAuthenticatedBuilderUserId(req);

    // ── Request audit log ─────────────────────────────────────────────────────
    // This is the definitive ground truth of what the frontend sent. If jobTitle
    // or company is missing here, the upstream payload is the bug.
    console.log("[tailor.controller] ← request body audit", {
      hasUserId: !!userId,
      hasResumeId: !!resumeId,
      hasFields: !!(fields && Object.keys(fields ?? {}).length > 0),
      jobTitleReceived: jobTitle ?? "(MISSING)",
      companyReceived: company ?? "(MISSING)",
      jdChars: (jobDescription ?? "").length,
      jdPreview: (jobDescription ?? "").substring(0, 80),
    });

    if (!jobDescription) {
      res.status(400).json({ error: "jobDescription is required" });
      return;
    }

    // resumeId is optional: manual/unsaved resumes pass fields directly instead.
    if (!resumeId && (!fields || Object.keys(fields).length === 0)) {
      res.status(400).json({ error: "Either resumeId or fields must be provided" });
      return;
    }

    const result = await tailorResume({
      userId,
      resumeId,
      jobDescription,
      jobTitle,
      company,
      fields,
      idempotencyKey: req.idempotencyKey ?? null,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /resume/builder/export-pdf
 * Renders the populated HTML to a PDF and streams it directly to the client.
 *
 * Response: application/pdf binary stream.
 * Useful headers also exposed for the frontend:
 *   - X-PDF-Filename       — suggested download filename
 *   - X-PDF-Download-Url   — archived URL under /uploads/exports/ (24h)
 *   - X-PDF-Total-Ms       — total render duration
 */
export async function exportPdfHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const _ct0 = Date.now();
  try {
    const { resumeId, populatedHtml, suggestedFilename } = req.body as Partial<ExportPdfInput>;
    const userId = await resolveAuthenticatedBuilderUserId(req);
    console.info(JSON.stringify({ event: "pdf_handler_start", resumeId: resumeId ?? null, htmlBytes: populatedHtml?.length ?? 0 }));

    if (!resumeId && !populatedHtml) {
      res.status(400).json({ error: "resumeId or populatedHtml is required" });
      return;
    }

    const result = await exportResumeHtml({ userId, resumeId, populatedHtml, suggestedFilename });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.setHeader("Content-Length", String(result.buffer.length));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-PDF-Filename",     result.filename);
    res.setHeader("X-PDF-Download-Url", result.downloadUrl);
    res.setHeader("X-PDF-Total-Ms",     String(result.timing.totalMs));
    res.setHeader("Access-Control-Expose-Headers", "X-PDF-Filename, X-PDF-Download-Url, X-PDF-Total-Ms");
    res.status(200).end(result.buffer);
    console.info(JSON.stringify({ event: "pdf_handler_done", totalMs: result.timing.totalMs, controllerMs: Date.now() - _ct0 }));
  } catch (err) {
    if (err instanceof PdfExportError) {
      const httpStatus =
        err.code === PDF_ERROR_CODES.PDF_TIMEOUT           ? 408 :
        err.code === PDF_ERROR_CODES.BROWSER_CRASH         ? 502 :
        err.code === PDF_ERROR_CODES.TEMPLATE_RENDER_ERROR ? 422 : 500;
      console.error(JSON.stringify({ event: "pdf_handler_error", code: err.code, error: err.message, ms: Date.now() - _ct0 }));
      res.status(httpStatus).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

/**
 * POST /resume/builder/extract-fields
 * Uses AI to parse raw resume text into structured ResumeFields.
 * Costs 0.5 credits.
 */
export async function extractFieldsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { resumeContext, jobDescription, jobTitle, company } =
      req.body as Partial<ExtractFieldsInput>;
    const userId = await resolveAuthenticatedBuilderUserId(req);

    if (!resumeContext) {
      res.status(400).json({ error: "resumeContext is required" });
      return;
    }

    const result = await extractFields({
      userId,
      resumeContext,
      jobDescription,
      jobTitle,
      company,
      idempotencyKey: req.idempotencyKey ?? null,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /resume/builder/:id/complete
 * Marks a built resume as completed (status = "completed", downloadedAt = now).
 * Called by the frontend after a successful export + the editor is clean (no unsaved changes).
 */
export async function markBuiltResumeCompleteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const userId = await resolveAuthenticatedBuilderUserId(req);

    const result = await markBuiltResumeComplete({ resumeId: String(id), userId });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /resume/builder/validate-section
 * AI-evaluates a single resume section quality. Free — no credits consumed.
 * Returns score (0–100), status, issues, suggestions, and dynamic min/max constraints.
 */
export async function validateSectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { sectionId, currentText, jobTitle, company, resumeContext } =
      req.body as Partial<ValidateSectionInput>;

    if (!sectionId || typeof currentText !== "string") {
      res.status(400).json({ error: "sectionId and currentText are required" });
      return;
    }

    const result = await validateSection({
      sectionId,
      currentText,
      jobTitle,
      company,
      resumeContext,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /resume/builder/:id/rename
 * Updates the title of a built resume.
 */
export async function renameBuiltResumeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = String(req.params.id);
    const { title } = req.body as { title?: string };

    if (!title || !title.trim()) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    const userId = await resolveAuthenticatedBuilderUserId(req);
    const updated = await renameBuiltResume(id, title.trim(), userId);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /resume/builder/ats-score
 * Runs an ATS-style analysis on the user's saved BuiltResume. Free.
 */
export async function builderAtsScoreHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = await resolveAuthenticatedBuilderUserId(req);

    const { resumeId, jobDescription } = req.body as { resumeId?: string; jobDescription?: string };
    if (!resumeId) {
      res.status(400).json({ error: "resumeId is required" });
      return;
    }

    const result = await scoreBuilderAts({ userId, resumeId, jobDescription });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /resume/builder/rewrite
 * Full resume rewrite targeting a specific role — no job description required.
 */
export async function rewriteResumeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = await resolveAuthenticatedBuilderUserId(req);

    const { resumeId, jobTitle, company, targetLevel, fields } = req.body as RewriteResumeInput;
    if (!jobTitle?.trim()) {
      res.status(400).json({ error: "jobTitle is required" });
      return;
    }

    const result = await rewriteResume({
      userId,
      resumeId,
      jobTitle: jobTitle.trim(),
      company,
      targetLevel,
      fields,
      idempotencyKey: req.idempotencyKey ?? null,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /resume/builder/inject-skills
 * Analyses resume + job description, injects missing role-relevant skills.
 */
export async function injectSkillsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = await resolveAuthenticatedBuilderUserId(req);

    const { resumeId, jobDescription, jobTitle, fields } = req.body as InjectSkillsInput;
    if (!fields) {
      res.status(400).json({ error: "fields is required" });
      return;
    }

    const result = await injectSkills({
      userId,
      resumeId,
      jobDescription,
      jobTitle,
      fields,
      idempotencyKey: req.idempotencyKey ?? null,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /resume/builder/inject-keywords
 * Weaves missing JD keywords naturally into resume sections.
 */
export async function injectKeywordsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = await resolveAuthenticatedBuilderUserId(req);

    const { resumeId, jobDescription, fields, selectedKeywords } = req.body as InjectKeywordsInput;
    if (!jobDescription || jobDescription.trim().length < 50) {
      res.status(400).json({ error: "jobDescription must be at least 50 characters" });
      return;
    }
    if (!fields) {
      res.status(400).json({ error: "fields is required" });
      return;
    }

    const result = await injectKeywords({
      userId,
      resumeId,
      jobDescription,
      fields,
      selectedKeywords,
      idempotencyKey: req.idempotencyKey ?? null,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /resume/builder/analyze-keywords
 * Extracts keywords from JD and suggests injection points. Costs 2 credits.
 */
export async function analyzeKeywordsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = await resolveAuthenticatedBuilderUserId(req);

    const { jobDescription, fields } = req.body as AnalyzeKeywordsInput;
    if (!jobDescription || jobDescription.trim().length < 50) {
      res.status(400).json({ error: "jobDescription must be at least 50 characters" });
      return;
    }
    if (!fields) {
      res.status(400).json({ error: "fields is required" });
      return;
    }

    const result = await analyzeKeywordsForInjection({
      userId,
      jobDescription,
      fields,
      idempotencyKey: req.idempotencyKey ?? null,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /resume/builder/keyword-match
 * Free text-analysis: checks which JD keywords are present/missing in resume.
 */
export async function keywordMatchHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { jobDescription, fields } = req.body as KeywordMatchInput;
    if (!jobDescription || jobDescription.trim().length < 10) {
      res.status(400).json({ error: "jobDescription is required" });
      return;
    }
    if (!fields) {
      res.status(400).json({ error: "fields is required" });
      return;
    }

    const result = analyzeKeywordMatch({ jobDescription, fields });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
