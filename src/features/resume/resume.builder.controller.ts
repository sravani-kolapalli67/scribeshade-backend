import { Request, Response, NextFunction } from "express";

import { getCurrentUserId } from "../auth/auth.middleware";
import {
  saveBuiltResume,
  listBuiltResumes,
  getBuiltResume,
  deleteBuiltResume,
  generateResumeHtml,
  enhanceSection,
  tailorResume,
  exportResumeHtml,
  extractFields,
  markBuiltResumeComplete,
} from "./resume.builder.service";
import type {
  SaveBuiltResumeInput,
  GenerateResumeHtmlInput,
  EnhanceSectionInput,
  TailorResumeInput,
  ExportPdfInput,
  ExtractFieldsInput,
  MarkBuiltResumeCompleteInput,
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
    res.json(resumes);
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
    const { userId, sectionId, currentText, jobDescription, jobTitle, resumeContext } =
      req.body as Partial<EnhanceSectionInput>;

    if (!userId || !sectionId || !currentText) {
      res.status(400).json({ error: "userId, sectionId, and currentText are required" });
      return;
    }

    const result = await enhanceSection({
      userId,
      sectionId,
      currentText,
      jobDescription,
      jobTitle,
      resumeContext,
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
    const { userId, resumeId, jobDescription, jobTitle, company } =
      req.body as Partial<TailorResumeInput>;

    if (!userId || !resumeId || !jobDescription) {
      res.status(400).json({ error: "userId, resumeId, and jobDescription are required" });
      return;
    }

    const result = await tailorResume({ userId, resumeId, jobDescription, jobTitle, company });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /resume/builder/export-pdf
 * Saves the populated HTML to disk and returns a download URL.
 */
export async function exportPdfHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId, resumeId, populatedHtml } = req.body as Partial<ExportPdfInput>;

    if (!resumeId && !populatedHtml) {
      res.status(400).json({ error: "resumeId or populatedHtml is required" });
      return;
    }

    const result = await exportResumeHtml({ userId: userId ?? "", resumeId, populatedHtml });
    res.json(result);
  } catch (err) {
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
    const { userId, resumeContext, jobDescription, jobTitle, company } =
      req.body as Partial<ExtractFieldsInput>;

    if (!userId || !resumeContext) {
      res.status(400).json({ error: "userId and resumeContext are required" });
      return;
    }

    const result = await extractFields({ userId, resumeContext, jobDescription, jobTitle, company });
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
