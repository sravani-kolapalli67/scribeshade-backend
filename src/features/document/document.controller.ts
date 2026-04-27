import { Request, Response } from "express";
import path from "path";
import fs from "fs";

import {
  createDocumentRecord,
  deleteDocument,
  extractTextFromFile,
  getDocumentsByUser,
  analyzeDocument,
} from "./document.service";

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function safeDeleteFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Silent
  }
}

function getStatusCode(err: unknown): number {
  if (err && typeof err === "object" && "statusCode" in err) {
    return (err as { statusCode: number }).statusCode;
  }
  return 500;
}

// ─────────────────────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /document/upload
 * Handles document upload, text extraction, and record creation.
 */
export async function uploadDocument(
  req: Request,
  res: Response,
): Promise<void> {
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

  try {
    const document = await createDocumentRecord({
      filename: req.file.filename,
      filePath: req.file.path,
      size: req.file.size,
      userId,
    });

    res.status(201).json(document);
  } catch (err) {
    safeDeleteFile(req.file.path);
    console.error("[document/upload] Failed:", err);
    res.status(500).json({ error: "Failed to process document upload" });
  }
}

/**
 * GET /document/list?userId=...
 * Returns all documents for a user.
 */
export async function listDocuments(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = req.query as { userId?: string };

  if (!userId) {
    res.status(400).json({ error: "Missing userId query parameter" });
    return;
  }

  try {
    const documents = await getDocumentsByUser(userId);
    res.json(documents);
  } catch (err) {
    console.error("[document/list] Failed:", err);
    res.status(500).json({ error: (err as Error).message });
  }
}

/**
 * DELETE /document/:id
 * Deletes a document.
 */
export async function removeDocument(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.params;

  try {
    await deleteDocument(id as string);
    res.json({ message: "Document deleted successfully" });
  } catch (err) {
    console.error("[document/delete] Failed:", err);
    const status = getStatusCode(err);
    res.status(status).json({ error: (err as Error).message });
  }
}

/**
 * POST /document/analyze
 * Runs AI analysis on a document.
 */
// export async function processDocument(req: Request, res: Response): Promise<void> {
//   const { documentId } = req.body as { documentId?: string };

//   if (!documentId) {
//     res.status(400).json({ error: "documentId is required" });
//     return;
//   }

//   try {
//     const result = await analyzeDocument(documentId);
//     res.json(result);
//   } catch (err) {
//     console.error("[document/analyze] Failed:", err);
//     const status = getStatusCode(err);
//     res.status(status).json({ error: (err as Error).message });
//   }
// }
