import { Request, Response } from "express";
import * as qaService from "./qa.service";

/**
 * Creates a new QA record.
 * Body: { sessionId?, companyId, ques, answer?, difficulty?, industry?, language?, isShared? }
 */
export async function createQA(req: Request, res: Response) {
  try {
    const body = req.body || {};

    if (!body.companyId || !body.ques) {
      return res
        .status(400)
        .json({ error: "companyId and ques are required" });
    }

    const qa = await qaService.createQA({
      companyId: body.companyId,
      sessionId: body.sessionId,
      ques: body.ques,
      answer: body.answer,
      difficulty: body.difficulty,
      industry: body.industry,
      language: body.language,
      isShared: body.isShared === true || body.isShared === "true",
    });

    return res.status(201).json({ success: true, data: qa });
  } catch (error: any) {
    console.error("Create QA Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Lists all QA records for a session.
 */
export async function listQAsBySession(req: Request, res: Response) {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const qas = await qaService.getQAsBySession(sessionId);
    return res.json(qas);
  } catch (error: any) {
    console.error("List QAs by Session Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Lists all QA records for a company.
 */
export async function listQAsByCompany(req: Request, res: Response) {
  try {
    const { companyId } = req.params as { companyId: string };
    const qas = await qaService.getQAsByCompany(companyId);
    return res.json(qas);
  } catch (error: any) {
    console.error("List QAs by Company Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Lists all QA records for a specific user.
 */
export async function listQAsByUser(req: Request, res: Response) {
  try {
    const { userId } = req.params as { userId: string };
    const qas = await qaService.getQAsByUser(userId);
    return res.json(qas);
  } catch (error: any) {
    console.error("List QAs by User Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Lists all publicly shared QA records.
 */
export async function listSharedQAs(req: Request, res: Response) {
  try {
    const qas = await qaService.getSharedQAs();
    return res.json(qas);
  } catch (error: any) {
    console.error("List Shared QAs Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Gets a single QA record by ID.
 */
export async function getQA(req: Request, res: Response) {
  try {
    const { id } = req.params as { id: string };
    const qa = await qaService.getQAById(id);

    if (!qa) {
      return res.status(404).json({ error: "QA not found" });
    }

    return res.json(qa);
  } catch (error: any) {
    console.error("Get QA Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Updates a QA record (e.g. adds or edits the answer).
 * Body: { answer?, difficulty?, industry?, language?, isShared? }
 */
export async function updateQA(req: Request, res: Response) {
  try {
    const { id } = req.params as { id: string };
    const body = req.body || {};

    const qa = await qaService.updateQA(id, {
      answer: body.answer,
      difficulty: body.difficulty,
      industry: body.industry,
      language: body.language,
      isShared:
        body.isShared !== undefined
          ? body.isShared === true || body.isShared === "true"
          : undefined,
    });

    return res.json({ success: true, data: qa });
  } catch (error: any) {
    console.error("Update QA Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}

/**
 * Deletes a QA record.
 */
export async function deleteQA(req: Request, res: Response) {
  try {
    const { id } = req.params as { id: string };
    await qaService.deleteQA(id);
    return res.json({ success: true });
  } catch (error: any) {
    console.error("Delete QA Error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
}
