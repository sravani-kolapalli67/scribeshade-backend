import { Express } from "express";
import cors from "cors";
import express from "express";
import morgan from "morgan";
import { clerkAuth } from "./features/auth/auth.middleware";
import { router } from "./routes";
import { errorMiddleware } from "./shared/middleware/error.middleware";

export const createApp: () => Express = () => {
  const app = express();

  // Standard middleware
  app.use(morgan("dev"));
  app.use(cors({ origin: "*", credentials: true }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/uploads", express.static("uploads"));

  // Clerk authentication middleware (global)
  app.use(clerkAuth);

  app.use("/api", router);

  // Global Error Handler (must be last)
  app.use(errorMiddleware);

  return app;
};
