import { Router } from "express";
import { authRouter } from "../features/auth/auth.routes";
// import { userRouter } from "../features/user/user.routes";
import { resumeRouter } from "../features/resume/resume.router";

const router = Router();

router.use("/auth", authRouter);
// router.use("/users", userRouter);
router.use("/resume", resumeRouter);

// Health check
router.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

export { router };
