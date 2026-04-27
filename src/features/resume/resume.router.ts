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
  scoreAts,
  uploadResume,
} from "./resume.controller";

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
router.delete("/:id", removeResume);

// ATS Analysis
router.post("/ats-score", scoreAts);
router.get("/all-ats", listAtsResumes);

// Cover Letter
router.post("/generate-cover-letter", coverLetter);

// Templates
router.post("/create-template", addTemplate);
router.get("/all-templates", listTemplates);

// ─────────────────────────────────────────────────────────────────────────────

export { router as resumeRouter };
