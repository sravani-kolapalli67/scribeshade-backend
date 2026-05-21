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

    const keepAlive = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        clearInterval(keepAlive);
        return;
      }

      res.write(": keep-alive\n\n");
      if ((res as any).flush) {
        (res as any).flush();
      }
    }, 25_000);

    // Remove client on connection close
    res.on("close", () => {
      clearInterval(keepAlive);
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
    const deadClients: Response[] = [];
    
    clients.forEach((res) => {
      // Check if response is still writable before attempting to write
      if (res.writableEnded || !res.writable) {
        deadClients.push(res);
        return;
      }
      
      try {
        res.write(payload);
        // For some environments like Heroku/NGINX, we might need to flush
        if ((res as any).flush) {
          (res as any).flush();
        }
      } catch (err) {
        // Write failed, mark client as dead for cleanup
        console.error("[SSE Manager] Failed to write to client:", err);
        deadClients.push(res);
      }
    });
    
    // Clean up dead clients from the Set
    deadClients.forEach((res) => {
      clients.delete(res);
    });
    
    // Remove session entry if no clients remain
    if (clients.size === 0) {
      this.clients.delete(sessionId);
    }
  }
}

export const sseManager = new SSEManager();
