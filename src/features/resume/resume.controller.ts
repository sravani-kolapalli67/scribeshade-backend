import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import {
  createResumeRecord,
  deleteResume,
  renameResume,
  extractTextFromFile,
  generateCoverLetter,
  getAllTemplates,
  getAtsResumesByUser,
  getResumesByUser,
  runAtsAnalysis,
  createTemplate,
  validateIsResume,
} from "./resume.service";
import { CoverLetterRequest, CreateTemplateRequest } from "./resume.types";

// ─────────────────────────────────────────────────────────────────────────────
// Internal Utility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safely deletes a file from the filesystem, suppressing any errors.
 * Kept here (controller layer) because it is only needed for request cleanup.
 */
function safeDeleteFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Intentionally silent — best-effort cleanup
  }
}

/**
 * Maps a service-layer Error with an attached `statusCode` property to the
 * correct HTTP status. Falls back to 500 for unrecognised errors.
 */
function getStatusCode(err: unknown): number {
  if (err && typeof err === "object" && "statusCode" in err) {
    return (err as { statusCode: number }).statusCode;
  }
  return 500;
}

export async function uploadResume(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const { userId } = req.body as { userId?: string };

  if (!userId) {
    safeDeleteFile(req.file.path);
    res.status(400).json({ error: "Missing userId" });
    return;
  }

  const ext = path.extname(req.file.originalname).toLowerCase();

  // Step 1: Extract text
  let extractedText: string;
  try {
    extractedText = await extractTextFromFile(req.file.path, ext);
  } catch (err) {
    safeDeleteFile(req.file.path);
    console.error("[resume/upload] Text extraction failed:", err);
    res.status(400).json({ error: "Failed to extract text from file" });
    return;
  }

  if (!extractedText.trim()) {
    safeDeleteFile(req.file.path);
    res.status(400).json({ error: "Could not extract any text from the file" });
    return;
  }

  // Step 2: AI validation
  let isResume: boolean;
  try {
    isResume = await validateIsResume(extractedText);
  } catch (err) {
    safeDeleteFile(req.file.path);
    console.error("[resume/upload] AI validation failed:", err);
    res.status(500).json({ error: "Failed to validate the document" });
    return;
  }

  if (!isResume) {
    safeDeleteFile(req.file.path);
    res.status(400).json({
      error:
        "Please upload a valid resume. The uploaded file does not appear to be a resume/CV.",
    });
    return;
  }

  // Step 3: Persist
  try {
    const normalizedFilename = req.file.originalname.toLowerCase();
    const metadataIndex = {
      normalizedFilename,
      keywords: Array.from(
        new Set(
          `${req.file.originalname} ${extractedText}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .split(" ")
            .filter((term) => term.length >= 3),
        ),
      ).slice(0, 120),
    };

    const resume = await createResumeRecord({
      filename: req.file.filename,
      filePath: req.file.path,
      size: req.file.size,
      resumeContext: extractedText,
      metadataIndex,
      userId,
    });

    res.status(201).json(resume);
  } catch (err) {
    safeDeleteFile(req.file.path);
    console.error("[resume/upload] DB insert failed:", err);
    res.status(500).json({ error: "Failed to save resume" });
  }
}

/**
 * GET /resume/list?userId=...
 * Returns all resumes belonging to a user.
 */
export async function listResumes(req: Request, res: Response): Promise<void> {
  const { userId, search } = req.query as { userId?: string; search?: string };

  if (!userId) {
    res.status(400).json({ error: "Missing userId query parameter" });
    return;
  }

  try {
    const resumes = await getResumesByUser(userId, search);
    res.json(resumes);
  } catch (err) {
    console.error("[resume/list]", err);
    res.status(500).json({ error: (err as Error).message });
  }
}

/**
 * GET /resume/all-ats?userId=...
 * Returns all ATS-analysed resumes with their analysis data.
 */
export async function listAtsResumes(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = req.query as { userId?: string };

  if (!userId) {
    res.status(400).json({ error: "Missing userId query parameter" });
    return;
  }

  try {
    const resumes = await getAtsResumesByUser(userId);
    res.json(resumes);
  } catch (err) {
    console.error("[resume/all-ats]", err);
    res.status(500).json({ error: (err as Error).message });
  }
}

/**
 * POST /resume/ats-score
 * Runs ATS analysis on a resume and returns the result.
 */
export async function scoreAts(req: Request, res: Response): Promise<void> {
  const { resumeId } = req.body as { resumeId?: string };

  if (!resumeId) {
    res.status(400).json({ error: "resumeId is required" });
    return;
  }

  try {
    const { creditsUsed, creditsRemaining, ...analysis } = await runAtsAnalysis(resumeId);
    res.json({ ...analysis, creditsUsed, creditsRemaining });
  } catch (err) {
    console.error("[resume/ats-score]", err);
    const status = getStatusCode(err);
    res.status(status).json({ error: (err as Error).message });
  }
}

/**
 * POST /resume/generate-cover-letter
 * Generates a tailored cover letter based on the resume and job details.
 */
export async function coverLetter(req: Request, res: Response): Promise<void> {
  const { resumeId, userId, jobRole, company, jobDescription, tone, userName, userEmail } =
    req.body as CoverLetterRequest & { resumeId?: string };

  if (!resumeId) {
    res.status(400).json({ error: "resumeId is required" });
    return;
  }

  try {
    const result = await generateCoverLetter({
      resumeId,
      userId,
      jobRole,
      company,
      jobDescription,
      tone,
      userName,
      userEmail,
    });

    res.json(result);
  } catch (err) {
    console.error("[resume/generate-cover-letter]", err);
    const status = getStatusCode(err);
    res.status(status).json({ error: (err as Error).message });
  }
}

/**
 * POST /resume/create-template
 * Creates a new resume template.
 */
export async function addTemplate(req: Request, res: Response): Promise<void> {
  const { name, category, thumbnail, code } =
    req.body as Partial<CreateTemplateRequest>;

  if (!name || !category || !thumbnail || !code) {
    res
      .status(400)
      .json({ error: "name, category, thumbnail, and code are required" });
    return;
  }

  try {
    const template = await createTemplate({ name, category, thumbnail, code });
    res.status(201).json(template);
  } catch (err) {
    console.error("[resume/create-template]", err);
    res.status(500).json({ error: (err as Error).message });
  }
}

/**
 * GET /resume/all-templates
 * Returns all available resume templates.
 */
export async function listTemplates(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const templates = await getAllTemplates();
    res.json(templates);
  } catch (err) {
    console.error("[resume/all-templates]", err);
    res.status(500).json({ error: (err as Error).message });
  }
}

/**
 * DELETE /resume/:id
 * Deletes a resume and its associated file.
 */
export async function removeResume(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  try {
    await deleteResume(id as string);
    res.json({ message: "Resume deleted successfully" });
  } catch (err) {
    console.error("[resume/delete]", err);
    const status = getStatusCode(err);
    res.status(status).json({ error: (err as Error).message });
  }
}

export async function renameResumeHandler(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;
  const { filename } = req.body as { filename?: string };

  if (!filename || !filename.trim()) {
    res.status(400).json({ error: "filename is required" });
    return;
  }

  try {
    const updated = await renameResume(id, filename);
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error("[resume/rename]", err);
    const status = getStatusCode(err);
    res.status(status).json({ error: (err as Error).message });
  }
}
