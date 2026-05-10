import { Router } from "express";
import multer, { StorageEngine, FileFilterCallback } from "multer";
import path from "path";
import fs from "fs";
import { Request } from "express";

import { UPLOAD_DIR, ALLOWED_EXTENSIONS } from "./resume.service";
import {
  addTemplate,
  coverLetter,
  listAtsResumes,
  listResumes,
  listTemplates,
  removeResume,
  renameResumeHandler,
  scoreAts,
  uploadResume,
} from "./resume.controller";
import {
  saveBuiltResumeHandler,
  listBuiltResumesHandler,
  getBuiltResumeHandler,
  deleteBuiltResumeHandler,
  renameBuiltResumeHandler,
  generateResumeHtmlHandler,
  enhanceSectionHandler,
  tailorResumeHandler,
  exportPdfHandler,
  extractFieldsHandler,
  markBuiltResumeCompleteHandler,
  validateSectionHandler,
  builderAtsScoreHandler,
} from "./resume.builder.controller";
import { requireAuth } from "../auth/auth.middleware";
import { idempotencyKeyMiddleware } from "../../shared/middleware/idempotency.middleware";

// ─────────────────────────────────────────────────────────────────────────────
// Multer (File Upload Middleware)
// ─────────────────────────────────────────────────────────────────────────────

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage: StorageEngine = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    const unique = `${basename}_${Date.now()}${ext}`;
    cb(null, unique);
  },
});

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback,
): void => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Only PDF, DOC, and DOCX files are allowed"));
  }
};

const upload = multer({ storage, fileFilter });

const router = Router();

// Resume CRUD
router.post("/upload", upload.single("resume"), uploadResume);
router.get("/list", listResumes);
router.patch("/:id/rename", renameResumeHandler);
router.delete("/:id", removeResume);

// ATS Analysis
router.post("/ats-score", scoreAts);
router.get("/all-ats", listAtsResumes);

// Cover Letter
router.post("/generate-cover-letter", coverLetter);

// Templates
router.post("/create-template", addTemplate);
router.get("/all-templates", listTemplates);

// ── Builder (CRUD) ────────────────────────────────────────────────────────────
router.post("/builder/save", requireAuth, saveBuiltResumeHandler);
router.get("/builder/list", requireAuth, listBuiltResumesHandler);
router.get("/builder/:id", requireAuth, getBuiltResumeHandler);
router.patch("/builder/:id/rename", requireAuth, renameBuiltResumeHandler);
router.delete("/builder/:id", requireAuth, deleteBuiltResumeHandler);

// ── Builder (AI) ──────────────────────────────────────────────────────────────
// All credit-deducting AI endpoints accept an `Idempotency-Key` header so
// duplicate clicks / retries never double-bill. See
// shared/middleware/idempotency.middleware.ts and
// features/credits/ai-credit-meter.service.ts.
router.post(
  "/builder/generate",
  requireAuth,
  idempotencyKeyMiddleware,
  generateResumeHtmlHandler,
);
router.post(
  "/builder/enhance-section",
  requireAuth,
  idempotencyKeyMiddleware,
  enhanceSectionHandler,
);
router.post("/builder/validate-section", requireAuth, validateSectionHandler);
router.post("/builder/ats-score", requireAuth, builderAtsScoreHandler);
router.post(
  "/builder/tailor",
  requireAuth,
  idempotencyKeyMiddleware,
  tailorResumeHandler,
);
router.post("/builder/export-pdf", requireAuth, exportPdfHandler);
router.post(
  "/builder/extract-fields",
  requireAuth,
  idempotencyKeyMiddleware,
  extractFieldsHandler,
);
router.post("/builder/:id/complete", requireAuth, markBuiltResumeCompleteHandler);

// ─────────────────────────────────────────────────────────────────────────────

export { router as resumeRouter };
