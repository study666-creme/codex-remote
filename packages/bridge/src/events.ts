import crypto from "node:crypto";
import type { ServerResponse } from "node:http";

import { VERSION } from "./config.js";

export class EventHub {
  private clients = new Map<string, ServerResponse>();
  private history: BufferedEvent[] = [];
  private nextEventId = 1;

  health() {
    return { ok: true, clients: this.clients.size, version: VERSION };
  }

  openEvents(url: URL, res: ServerResponse, lastEventIdHeader = "") {
    const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
    const previous = this.clients.get(clientId);
    if (previous && previous !== res) previous.end();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Encoding": "identity",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.socket?.setKeepAlive(true);
    this.clients.set(clientId, res);
    res.write("retry: 2000\n\n");
    sendEvent(res, "hello", { ok: true, clientId, version: VERSION });

    const lastEventId = Number(lastEventIdHeader || url.searchParams.get("lastEventId") || 0);
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
      this.history.filter((event) => event.id > lastEventId).forEach((event) => sendEvent(res, event.type, event.payload, event.id));
    }

    const timer = setInterval(() => sendEvent(res, "ping", { time: Date.now() }), 15000);
    res.on("close", () => {
      clearInterval(timer);
      if (this.clients.get(clientId) === res) this.clients.delete(clientId);
    });
  }

  emitAll(type: string, payload: unknown) {
    const event = { id: this.nextEventId++, type, payload };
    if (type === "agent_event" || type === "agent_done" || type === "agent_error") {
      this.history.push(event);
      if (this.history.length > 400) this.history.splice(0, this.history.length - 400);
    }
    this.clients.forEach((client, clientId) => {
      if (client.destroyed) {
        this.clients.delete(clientId);
        return;
      }
      sendEvent(client, type, payload, event.id);
    });
  }
}

type BufferedEvent = { id: number; type: string; payload: unknown };

function sendEvent(res: ServerResponse, type: string, payload: unknown, id?: number) {
  res.write(`${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
