import multer from "multer";
import path from "path";
import fs from "fs";
import { UPLOAD_DIR, ALLOWED_EXTENSIONS } from "../resume/resume.service";
import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import * as projectsController from "./projects.controller";

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    const unique = `${basename}_${Date.now()}${ext}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, DOC, and DOCX files are allowed") as any);
    }
  },
});

const projectsRouter = Router();

/**
 * POST /api/projects/generate
 * Generates AI-suggested projects based on resume and job context.
 * Supports file upload (resume) or resumeId/resumeText.
 */
projectsRouter.post(
  "/generate",
  requireAuth,
  upload.single("resume"),
  projectsController.generateProjects,
);

/**
 * GET /api/projects/mine
 * Returns all generated projects for the currently authenticated user.
 * Resolves user via Bearer token — no userId param needed.
 */
projectsRouter.get("/mine", requireAuth, projectsController.listMyProjects);

/**
 * GET /api/projects/user/:userId
 * Returns all generated projects for a specific user.
 */
projectsRouter.get("/user/:userId", projectsController.listProjectsByUser);

/**
 * GET /api/projects/:id
 * Returns a single project record by its database ID.
 */
projectsRouter.get("/:id", projectsController.getProject);

/**
 * DELETE /api/projects/:id
 * Permanently deletes a project record.
 */
projectsRouter.delete("/:id", projectsController.deleteProject);

/**
 * PATCH /api/projects/:id
 * Updates mutable fields (position label).
 */
projectsRouter.patch("/:id", projectsController.updateProject);

/**
 * PUT /api/projects/:id/projects
 * Replaces the projects JSON, saving the old content as a versioned snapshot.
 * Used by the regen flow so history is never lost.
 */
projectsRouter.put("/:id/projects", requireAuth, projectsController.replaceProjects);

/**
 * GET /api/projects/:id/versions
 * Lists all version snapshots for a project (newest first).
 */
projectsRouter.get("/:id/versions", requireAuth, projectsController.listProjectVersions);

/**
 * POST /api/projects/:id/versions/:versionId/rollback
 * Rolls the project back to a specific version snapshot.
 */
projectsRouter.post("/:id/versions/:versionId/rollback", requireAuth, projectsController.rollbackProject);

/**
 * POST /api/projects/:id/edit-component
 * Regenerates a single project section (1 credit).
 */
projectsRouter.post("/:id/edit-component", projectsController.editProjectComponent);

/**
 * GET /api/projects/:id/export-pdf
 * Renders all projects for a record into a structured A4 PDF via Playwright.
 */
projectsRouter.get("/:id/export-pdf", requireAuth, projectsController.exportProjectPdf);

export { projectsRouter };
