import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { createApp } from "./app";
import { env } from "./config/env";
import { creditDeductionWorker } from "./features/jobs/credit-deduction.job";
import { sessionWatchdogWorker, scheduleWatchdog } from "./features/jobs/session-watchdog.job";
import { holdExpiryWorker } from "./features/jobs/hold-expiry.job";

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

    // Schedule the recurring watchdog tick
    scheduleWatchdog().catch((err) =>
      console.error("⚠️  Failed to schedule session watchdog:", err),
    );

    console.log("⚙️  BullMQ workers started");
  });
};

startServer().catch((error) => {
  console.error("💥 Failed to start server:", error);
  process.exit(1);
});
