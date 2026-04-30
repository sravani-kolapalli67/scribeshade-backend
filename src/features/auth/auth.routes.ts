import { NextFunction, Request, Response, Router } from "express";
import { clerkAuth, getCurrentUserId, requireAuth } from "./auth.middleware";
import { getUserByClerkId, handleWebhook, syncUser } from "./auth.service";
import express from "express";
import { clerkClient } from "@clerk/express";

const router = Router();

router.get("/me", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clerkId = getCurrentUserId(req);
    let user = await getUserByClerkId(clerkId);

    if (!user) {
      console.log(`User ${clerkId} not found in DB. Syncing from Clerk...`);
      // Fetch user from Clerk
      const clerkUser = await clerkClient.users.getUser(clerkId);
      const email = clerkUser.emailAddresses[0]?.emailAddress;
      const name =
        `${clerkUser.firstName || ""} ${clerkUser.lastName || ""}`.trim() ||
        undefined;

      user = await syncUser(clerkId, email, name);
    }

    console.log("🚀 ~ user:", user);
    res.json(user);
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/tauri-ticket
router.post(
  "/tauri-ticket",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getCurrentUserId(req);

      const token = await clerkClient.signInTokens.createSignInToken({
        userId,
        expiresInSeconds: 60,
      });

      res.json({ ticket: token.token });
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/auth/webhook
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response, next: NextFunction) => {
    const result = await handleWebhook(req.body, req.headers);
    res.status(200).json(result);
  },
);

export { router as authRouter };
