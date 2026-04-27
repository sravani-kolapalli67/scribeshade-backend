import multer from "multer";
import path from "path";
import fs from "fs";
import { UPLOAD_DIR, ALLOWED_EXTENSIONS } from "../resume/resume.service";
import { Router } from "express";
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
  upload.single("resume"),
  projectsController.generateProjects,
);

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

export { projectsRouter };
