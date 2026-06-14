import { Express } from "express";
import cors from "cors";
import express from "express";
import morgan from "morgan";
import { clerkAuth } from "./features/auth/auth.middleware";
import { env } from "./config/env";
import { router } from "./routes";
import { errorMiddleware } from "./shared/middleware/error.middleware";
import { resolveUserId } from "./shared/middleware/resolve-user-id.middleware";

export const createApp: () => Express = () => {
  const app = express();

  // Standard middleware
  app.use(morgan("dev"));
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  // 10 MB body limit — default is 100 KB which caused PayloadTooLargeError
  // on long resume/JD pastes and large interview prompts.
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));
  app.use("/uploads", express.static("uploads"));

  // Transparently resolve Clerk IDs → internal DB UUIDs on every request
  app.use(resolveUserId);

  // Clerk authentication middleware (global)
  app.use(clerkAuth);

  app.use("/api", router);

  // Global Error Handler (must be last)
  app.use(errorMiddleware);

  return app;
};
