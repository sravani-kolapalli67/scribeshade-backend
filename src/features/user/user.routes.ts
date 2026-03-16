import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { UserController } from "./user.controller";

const router = Router();

// All user routes require authentication
router.use(requireAuth);

router.get("/me", UserController.getMe);

export { router as userRouter };
