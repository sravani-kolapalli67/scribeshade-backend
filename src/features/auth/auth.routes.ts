import { NextFunction, Request, Response, Router } from "express";
import { getCurrentUserId, requireAuth } from "./auth.middleware";
import { AuthService } from "./auth.service";

const router = Router();

// Sync Clerk user with local DB
router.post("/sync", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clerkId = getCurrentUserId(req);
    const { email, name } = req.body;
    const user = await AuthService.syncUser(clerkId, email, name);
    res.json(user);
  } catch (error) {
    next(error);
  }
});

export { router as authRouter };
