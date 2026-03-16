import { Router } from "express";
import { authRouter } from "../features/auth/auth.routes";
import { userRouter } from "../features/user/user.routes";

const router = Router();

router.use("/auth", authRouter);
router.use("/users", userRouter);

// Health check
router.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

export { router };
