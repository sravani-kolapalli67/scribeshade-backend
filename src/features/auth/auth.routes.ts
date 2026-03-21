import { NextFunction, Request, Response, Router } from "express";
import { clerkAuth, getCurrentUserId, requireAuth } from "./auth.middleware";
import { getUserByClerkId, handleWebhook, syncUser } from "./auth.service";
import express from "express";

const router = Router();

// POST /api/auth/sync
// Syncs authenticated Clerk user with local DB (call after login/signup)
// router.post(
//   "/sync",
//   requireAuth,
//   async (req: Request, res: Response, next: NextFunction) => {
//     try {
//       const clerkId = getCurrentUserId(req);
//       const { email, name } = req.body;
//       const user = await syncUser(clerkId, email, name);
//       res.json(user);
//     } catch (error) {
//       next(error);
//     }
//   },
// );

// GET /api/auth/me
// Returns the current user's profile from the local DB

router.get("/me", async (req: Request, res: Response, next: NextFunction) => {
  try {
    console.log(req);
    const clerkId = getCurrentUserId(req);
    const user = await getUserByClerkId(clerkId);
    console.log("🚀 ~ user:", user);
    res.json(user);
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/webhook
// Receives and processes Clerk webhook events (user.created, user.updated, user.deleted)
// Requires raw body — uses express.raw() to bypass JSON parsing for svix verification

router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response, next: NextFunction) => {
    console.log("webhook --------->");
    const result = await handleWebhook(req.body, req.headers);
    res.status(200).json(result);
    // try {
    //   const rawBody = req.body;
    //   const headers = req.headers;
    //   const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
    //   if (!webhookSecret) {
    //     throw new AppError(500, "CLERK_WEBHOOK_SECRET is not configured");
    //   }
    //   const wh = new Webhook(webhookSecret);
    //   let event: { type: string; data: any };
    //   try {
    //     event = wh.verify(rawBody, {
    //       //   "svix-id": headers["svix-id"] as string,
    //       //   "svix-timestamp": headers["svix-timestamp"] as string,
    //       "svix-signature": headers["svix-signature"] as string,
    //     }) as { type: string; data: any };
    //   } catch (err) {
    //     console.error("Webhook verification failed:", err);
    //     throw new AppError(400, "Invalid webhook signature");
    //   }
    //   const { type, data } = event;
    //   console.log("🚀 ~ type:", type);
    //   console.log("🚀 ~ data:", data);
    //   switch (type) {
    //     case "user.created":
    //     case "user.updated": {
    //       const clerkId: string = data.id;
    //       const email: string | undefined =
    //         data.email_addresses?.[0]?.email_address;
    //       const firstName: string | undefined = data.first_name;
    //       const lastName: string | undefined = data.last_name;
    //       const name =
    //         [firstName, lastName].filter(Boolean).join(" ") || undefined;
    //       await syncUser(clerkId, email, name);
    //       break;
    //     }
    //     case "user.deleted": {
    //       const clerkId: string = data.id;
    //       await prisma.user.deleteMany({ where: { clerkId } });
    //       break;
    //     }
    //     default:
    //       break;
    //   }
    //   res.json({ received: true, type });
    // } catch (error) {
    //   next(error);
    // }
  },
);

export { router as authRouter };
