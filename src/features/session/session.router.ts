import { Router } from "express";
import multer from "multer";
import * as sessionController from "./session.controller";

const router = Router();
const upload = multer(); // memory storage

// ─────────────────────────────────────────────────────────────────────────────
// Session Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @route POST /features/session/create-session
 * @desc Create a new interview session
 * @access Private
 */
router.post("/create-session", upload.any(), sessionController.createSession);

/**
 * @route GET /features/session/list
 * @desc List all sessions for a user
 * @access Private
 */
router.get("/list", sessionController.listSessions);

/**
 * @route GET /features/session/:id
 * @desc Get a specific session by ID
 * @access Private
 */
router.get("/:id", sessionController.getSession);

/**
 * @route DELETE /features/session/:id
 * @desc Delete a session
 * @access Private
 */
router.delete("/:id", sessionController.deleteSession);

/**
 * @route POST /features/session/:id/activate
 * @desc Activate a session
 * @access Private
 */
router.post("/:id/activate", sessionController.activateSession);

/**
 * @route POST /features/session/:id/deactivate
 * @desc Deactivate a session
 * @access Private
 */
router.post("/:id/deactivate", sessionController.deactivateSession);

/**
 * @route POST /features/session/:id/analyze-screen
 * @desc Analyze a screenshot and stream the AI response
 * @access Private
 */
router.post(
  "/:id/analyze-screen",
  upload.single("screenshot"),
  sessionController.analyzeScreen,
);

router.post(
  "/transcribe",
  upload.single("audio"),
  sessionController.transcribe,
);

router.post("/:id/ai-answer", sessionController.getAIAnswer);

router.post("/:id/save-message", sessionController.saveMessage);

export { router as sessionRouter };
