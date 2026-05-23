import { Express } from "express";
import cors from "cors";
import express from "express";
import morgan from "morgan";
import { clerkAuth } from "./features/auth/auth.middleware";
import { env } from "./config/env";
import { router } from "./routes";
import { errorMiddleware } from "./shared/middleware/error.middleware";
import { resolveUserId } from "./shared/middleware/resolve-user-id.middleware";

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

const tauriOriginPrefixes = ["tauri://localhost", "https://tauri.localhost"];

export const createApp: () => Express = () => {
  const app = express();
  const allowedOrigins = env.CORS_ORIGINS.map(normalizeOrigin);

  // Standard middleware
  app.use(morgan("dev"));
  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        // Allow non-browser clients (curl/server-to-server) without Origin header.
        if (!origin) {
          callback(null, true);
          return;
        }

        const normalized = normalizeOrigin(origin);
        const isTauriOrigin = tauriOriginPrefixes.some((prefix) => normalized.startsWith(prefix));

        if (allowedOrigins.includes(normalized) || isTauriOrigin) {
          callback(null, true);
          return;
        }

        callback(new Error(`CORS origin denied: ${origin}`));
      },
    }),
  );
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
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
