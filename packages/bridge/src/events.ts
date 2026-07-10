import crypto from "node:crypto";
import type { ServerResponse } from "node:http";

import { VERSION } from "./config.js";

export class EventHub {
  private clients = new Map<string, ServerResponse>();

  health() {
    return { ok: true, clients: this.clients.size, version: VERSION };
  }

  openEvents(url: URL, res: ServerResponse) {
    const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    this.clients.set(clientId, res);
    sendEvent(res, "hello", { ok: true, clientId, version: VERSION });

    const timer = setInterval(() => sendEvent(res, "ping", { time: Date.now() }), 15000);
    res.on("close", () => {
      clearInterval(timer);
      this.clients.delete(clientId);
    });
  }

  emitAll(type: string, payload: unknown) {
    this.clients.forEach((client) => sendEvent(client, type, payload));
  }
}

function sendEvent(res: ServerResponse, type: string, payload: unknown) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
