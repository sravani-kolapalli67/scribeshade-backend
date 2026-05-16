import { Router } from "express";
import { env } from "../config/env";
import { authRouter } from "../features/auth/auth.routes";
import { resumeRouter } from "../features/resume/resume.router";
import { sessionRouter } from "../features/session/session.router";
import { documentRouter } from "../features/document/document.router";
import { qaRouter } from "../features/qa/qa.router";
import { companyRouter } from "../features/company/company.router";
import { projectsRouter } from "../features/projects/projects.router";
import { creditsRouter } from "../features/credits/credits.router";
import { policyRouter } from "../features/policy/policy.router";
import { sessionNotesRouter } from "../features/session-notes/session-notes.router";
import { aiRouter } from "../features/ai/ai.router";
import { updatesRouter } from "../features/updates/updates.router";

import { askAiRouter } from "../features/ask-ai/ask-ai.router";

const router = Router();

router.use("/auth", authRouter);
router.use("/resume", resumeRouter);
router.use("/session", sessionRouter);
router.use("/document", documentRouter);
router.use("/qa", qaRouter);
router.use("/company", companyRouter);
router.use("/projects", projectsRouter);
router.use("/credits", creditsRouter);
router.use("/policy", policyRouter);
router.use("/session-notes", sessionNotesRouter);
router.use("/ask-ai", askAiRouter);
router.use("/", aiRouter);
router.use("/updates", updatesRouter);


// Health check
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    port: env.PORT,
  });
});

export { router };
