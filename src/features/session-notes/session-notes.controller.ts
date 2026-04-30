import { Request, Response, NextFunction } from "express";
import * as sessionNotesService from "./session-notes.service";
import { AppError } from "../../shared/middleware/error.middleware";

/**
 * POST /api/session-notes/:sessionId/generate
 * Generates and stores notes/summary for the session.
 */
export async function createNotes(req: Request, res: Response, next: NextFunction) {
  try {
    const { sessionId } = req.params;
    if (!sessionId) return next(new AppError(400, "sessionId is required"));

    const notes = await sessionNotesService.generateSessionNotes(sessionId as string);
    res.status(201).json({ success: true, data: notes });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/session-notes/:sessionId
 * Retrieves the notes/summary for the session.
 */
export async function getNotes(req: Request, res: Response, next: NextFunction) {
  try {
    const { sessionId } = req.params;
    if (!sessionId) return next(new AppError(400, "sessionId is required"));

    const notes = await sessionNotesService.getSessionNotes(sessionId as string);
    res.json({ success: true, data: notes });
  } catch (err) {
    next(err);
  }
}
