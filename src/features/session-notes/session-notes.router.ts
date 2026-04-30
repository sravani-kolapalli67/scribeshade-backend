import { Router } from "express";
import * as sessionNotesController from "./session-notes.controller";
import { requireAuth } from "../auth/auth.middleware";

const router = Router();

// Both routes are protected by default as they relate to specific user sessions
router.post("/:sessionId/generate", requireAuth, sessionNotesController.createNotes);
router.get("/:sessionId", requireAuth, sessionNotesController.getNotes);

export { router as sessionNotesRouter };
