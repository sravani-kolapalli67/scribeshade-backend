import { Request, Response, NextFunction } from "express";

import { getCurrentUserId } from "../auth/auth.middleware";
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
  MarkBuiltResumeCompleteInput,
  ValidateSectionInput,
} from "./resume.types";

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
    const { userId, resumeId, title, templateId, fields, sections, jobDescription, jobTitle, company } =
      req.body as Partial<SaveBuiltResumeInput>;

    if (!userId || !title || !templateId || !fields || !sections) {
      res
        .status(400)
        .json({ error: "userId, title, templateId, fields and sections are required" });
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
 * Lists all built resumes for a user. Accepts Clerk ID or DB UUID.
 */
export async function listBuiltResumesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req.query as { userId?: string };

    if (!userId) {
      res.status(400).json({ error: "userId query parameter is required" });
      return;
    }

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
    const resume = await getBuiltResume(String(id));
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
    await deleteBuiltResume(String(id));
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
    const { userId, templateCode, fields, jobDescription, jobTitle, company } =
      req.body as Partial<GenerateResumeHtmlInput>;

    if (!userId || !templateCode || !fields) {
      res.status(400).json({ error: "userId, templateCode, and fields are required" });
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
    const { userId: bodyUserId, sectionId, currentText, jobDescription, jobTitle, resumeContext } =
      req.body as Partial<EnhanceSectionInput>;

    // userId is preferred from the resolved body (resolveUserId middleware converts
    // Clerk IDs → DB UUIDs transparently). Fall back to the Clerk auth identity so
    // the endpoint works even when the frontend omits userId from the body.
    const userId = bodyUserId || getCurrentUserId(req);

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
    const { userId: bodyUserId, resumeId, jobDescription, jobTitle, company, fields } =
      req.body as Partial<TailorResumeInput>;
    // userId is preferred from the resolved body (resolveUserId middleware converts
    // Clerk IDs to DB UUIDs). Fall back to Clerk auth for resilience.
    const userId = bodyUserId || getCurrentUserId(req);

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

    if (!userId || !jobDescription) {
      res.status(400).json({ error: "userId and jobDescription are required" });
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
    const { userId, resumeId, populatedHtml } = req.body as Partial<ExportPdfInput>;
    console.info(JSON.stringify({ event: "pdf_handler_start", resumeId: resumeId ?? null, htmlBytes: populatedHtml?.length ?? 0 }));

    if (!resumeId && !populatedHtml) {
      res.status(400).json({ error: "resumeId or populatedHtml is required" });
      return;
    }

    const result = await exportResumeHtml({ userId: userId ?? "", resumeId, populatedHtml });

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
    const { userId: bodyUserId, resumeContext, jobDescription, jobTitle, company } =
      req.body as Partial<ExtractFieldsInput>;
    // userId is preferred from the resolved body (resolveUserId middleware converts
    // Clerk IDs to DB UUIDs). Fall back to Clerk auth for resilience.
    const userId = bodyUserId || getCurrentUserId(req);

    if (!userId || !resumeContext) {
      res.status(400).json({ error: "userId and resumeContext are required" });
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
    const { userId } = req.body as Partial<MarkBuiltResumeCompleteInput>;

    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

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

    const updated = await renameBuiltResume(id, title.trim());
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
    const userId = getCurrentUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { resumeId } = req.body as { resumeId?: string };
    if (!resumeId) {
      res.status(400).json({ error: "resumeId is required" });
      return;
    }

    const result = await scoreBuilderAts({ userId, resumeId });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
