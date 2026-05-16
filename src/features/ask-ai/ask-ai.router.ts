import { Router } from "express";
import * as controller from "./ask-ai.controller";

const router = Router();

// Ask AI routes use session-based grounding
router.post("/:sessionId/query", controller.askQuestion);
router.get("/:sessionId/history", controller.getHistory);
router.delete("/:sessionId/history", controller.clearHistory);
router.post("/:sessionId/index", controller.indexSession);

export { router as askAiRouter };
