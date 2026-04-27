import { Router } from "express";
import multer from "multer";
import * as sessionController from "./session.controller";

const router = Router();
const upload = multer(); // memory storage

// Session Routes

/**
 * @route POST /session/create-session
 */
router.post("/create-session", upload.any(), sessionController.createSession);

/**
 * @route GET /session/list
 */
router.get("/list", sessionController.listSessions);

/**
 * @route GET /session/:id
 */
router.get("/:id", sessionController.getSession);

/**
 * @route DELETE /session/:id
 */
router.delete("/:id", sessionController.deleteSession);

/**
 * @route POST /session/:id/activate
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

/**
 * @route POST /session/:id/ai-answer
 * @desc Get AI answer for a session
 * @access Private
 */
router.post("/:id/ai-answer", sessionController.getAIAnswer);

/**
 * @route POST /session/:id/save-message
 * @desc Save a message to a session
 * @access Private
 */
router.post("/:id/save-message", sessionController.saveMessage);

/**
 * @route GET /session/:id/analytics
 */
router.get("/:id/analytics", sessionController.getSessionAnalytics);

/**
 * @route POST /session/:id/analytics
 * @desc Force generate session analytics
 */
router.post("/:id/analytics", sessionController.generateSessionAnalytics);

export { router as sessionRouter };
