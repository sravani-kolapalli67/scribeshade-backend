import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { createApp } from "./app";
import { env } from "./config/env";

const startServer = async () => {
  const app = createApp();

  const server = http.createServer(app);

  server.listen(env.PORT, () => {
    console.log(`🚀 Server ready at: http://localhost:${env.PORT}`);
    console.log(`📡 Environment: ${env.NODE_ENV}`);
  });
};

startServer().catch((error) => {
  console.error("💥 Failed to start server:", error);
  process.exit(1);
});
