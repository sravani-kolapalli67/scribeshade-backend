import { Router } from "express";
import { authRouter } from "../features/auth/auth.routes";
import { resumeRouter } from "../features/resume/resume.router";
import { sessionRouter } from "../features/session/session.router";
import { documentRouter } from "../features/document/document.router";
import { qaRouter } from "../features/qa/qa.router";
import { companyRouter } from "../features/company/company.router";
import { projectsRouter } from "../features/projects/projects.router";

const router = Router();

router.use("/auth", authRouter);
// router.use("/users", userRouter);
router.use("/resume", resumeRouter);
router.use("/session", sessionRouter);
router.use("/document", documentRouter);
router.use("/qa", qaRouter);
router.use("/company", companyRouter);
router.use("/projects", projectsRouter);

// Health check
router.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

export { router };
