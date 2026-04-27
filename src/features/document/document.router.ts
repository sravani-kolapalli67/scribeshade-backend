import { Router } from "express";
import multer, { StorageEngine, FileFilterCallback } from "multer";
import path from "path";
import fs from "fs";
import { Request } from "express";

import { UPLOAD_DIR, ALLOWED_EXTENSIONS } from "./document.service";
import {
  listDocuments,
  removeDocument,
  uploadDocument,
} from "./document.controller";

// Multer Configuration

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
    cb(new Error(`Allowed extensions: ${ALLOWED_EXTENSIONS.join(", ")}`));
  }
};

const upload = multer({ storage, fileFilter });

const router = Router();

// Routes
router.post("/upload", upload.single("document"), uploadDocument);
router.get("/list", listDocuments);
router.delete("/:id", removeDocument);
// router.post("/analyze", processDocument);

export { router as documentRouter };
