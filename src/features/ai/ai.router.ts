import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import * as aiController from "./ai.controller";

const router = Router();

router.post("/ai/project-generation", requireAuth, aiController.generateProjectGeneration);
router.get("/project-categories", aiController.getProjectCategories);

export { router as aiRouter };
