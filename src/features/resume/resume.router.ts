import { Router, Request, Response } from "express";
import multer, { StorageEngine, FileFilterCallback } from "multer";
import path from "path";
import fs from "fs";
import { prisma } from "../../shared/lib/prisma";

const router = Router();

// ── Ensure upload directory exists ───────────────────────────
const uploadDir = "uploads/resumes";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ── Multer config ─────────────────────────────────────────────
const storage: StorageEngine = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req: Request, file: Express.Multer.File, cb) => {
    const unique = `resume_${req.body.userId}_${Date.now()}${path.extname(
      file.originalname,
    )}`;
    cb(null, unique);
  },
});

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback,
) => {
  const allowed = [".pdf", ".doc", ".docx"];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Only PDF, DOC, DOCX files are allowed"));
  }
};

const upload = multer({ storage, fileFilter });

// ── POST /resume/upload ───────────────────────────────────────
router.post(
  "/upload",
  upload.single("resume"),
  async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.body as { userId: string };

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    if (!userId) {
      res.status(400).json({ error: "Missing userId" });
      return;
    }

    try {
      const resume = await prisma.resume.create({
        data: {
          filename: req.file.filename,
          path: `${uploadDir}/${req.file.filename}`,
          userId,
        },
      });

      res.json(resume);
    } catch (err) {
      const error = err as Error;
      res.status(500).json({ error: error.message });
    }
  },
);

router.get("/list", async (req: Request, res: Response) => {
  try {
    const { userId } = req.query as { userId: string };
    const resumes = await prisma.resume.findMany({
      where: { userId },
    });
    res.json(resumes);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

export { router as resumeRouter };
