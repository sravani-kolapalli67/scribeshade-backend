import "./shared/utils/disable-debug-logs";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { createApp } from "./app";
import { env } from "./config/env";
import { creditDeductionWorker } from "./features/jobs/credit-deduction.job";
import { sessionWatchdogWorker, scheduleWatchdog } from "./features/jobs/session-watchdog.job";
import { holdExpiryWorker } from "./features/jobs/hold-expiry.job";
import { candidateDigestWorker } from "./features/jobs/candidate-digest.job";
import { warmBrowser } from "./features/resume/resume.builder.service";
import { validateAiConfig } from "./shared/utils/ai-validator";

process.on("unhandledRejection", (reason) => {
  console.error("[Process] Unhandled Promise Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[Process] Uncaught Exception:", error);
});


const startServer = async () => {
  const app = createApp();

  const server = http.createServer(app);

  server.listen(env.PORT, () => {
    console.log(`🚀 Server ready at: http://localhost:${env.PORT}`);
    console.log(`📡 Environment: ${env.NODE_ENV}`);

    // Boot BullMQ workers — importing starts them; keep references to prevent GC
    void creditDeductionWorker;
    void sessionWatchdogWorker;
    void holdExpiryWorker;
    void candidateDigestWorker;

    // Schedule the recurring watchdog tick
    scheduleWatchdog().catch((err) =>
      console.error("⚠️  Failed to schedule session watchdog:", err),
    );

    console.log("⚙️  BullMQ workers started");

    // Pre-warm Chromium so the first PDF export doesn't pay the cold-start cost
    warmBrowser();

    // Validate AI Configuration
    validateAiConfig();

  });
};

startServer().catch((error) => {
  console.error("💥 Failed to start server:", error);
  process.exit(1);
});
