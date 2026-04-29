import { Response } from "express";

/**
 * Simple manager for Server-Sent Events (SSE) connections.
 * Tracks active responses per sessionId to allow targeted notifications.
 */
class SSEManager {
  private clients: Map<string, Set<Response>> = new Map();

  /**
   * Register a new SSE client for a specific session.
   */
  addClient(sessionId: string, res: Response) {
    if (!this.clients.has(sessionId)) {
      this.clients.set(sessionId, new Set());
    }
    this.clients.get(sessionId)?.add(res);

    // Remove client on connection close
    res.on("close", () => {
      this.clients.get(sessionId)?.delete(res);
      if (this.clients.get(sessionId)?.size === 0) {
        this.clients.delete(sessionId);
      }
    });
  }

  /**
   * Broadcast an event to all clients subscribed to a sessionId.
   */
  notify(sessionId: string, event: string, data: any) {
    const clients = this.clients.get(sessionId);
    if (!clients) return;

    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    clients.forEach((res) => {
      res.write(payload);
      // For some environments like Heroku/NGINX, we might need to flush
      if ((res as any).flush) {
        (res as any).flush();
      }
    });
  }
}

export const sseManager = new SSEManager();
