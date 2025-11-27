// app.ts
import { Hono } from "hono";
import createDebug from "debug";
import type { WSContext } from "hono/ws";

import { upgradeWebSocket } from "../app";

const webrtcWsDebug = createDebug("webrtc-ws");

const webrtcWs = new Hono();

class Client {
  constructor(
    public readonly room: Room,
    public readonly ws: WSContext<WebSocket>
  ) {}

  emit(event: string, data?: unknown) {
    this.ws.send(JSON.stringify({ event, data }));
  }

  on(event: string, data?: unknown) {
    switch (event) {
      case "ping": {
        this.emit("pong");
        break;
      }
      case "offer":
      case "answer":
      case "candidate":
      case "candidates":
      case "candidates-request": {
        this.room.emitToOthers(this, event, data);
        break;
      }
    }
  }

  leave() {
    return this.room.removeClient(this);
  }
}

class Room {
  private static readonly rooms: Map<string, Room> = new Map();

  static createClient(id: string, ws: WSContext<WebSocket>) {
    return (this.rooms.get(id) ?? new Room(id))?.addClient(ws);
  }

  private readonly clients: Client[] = [];

  private constructor(public readonly id: string) {
    Room.rooms.set(id, this);
  }

  addClient(ws: WSContext<WebSocket>) {
    if (this.clients.length >= 2) {
      return null;
    }
    const client = new Client(this, ws);
    this.clients.push(client);
    if (this.clients.length > 1) {
      this.emitToOthers(client, "offer-request");
    }
    return client;
  }

  removeClient(client: Client) {
    const index = this.clients.indexOf(client);
    if (index !== -1) {
      const client = this.clients.splice(index, 1).at(0);
      return client ?? null;
    }
    if (this.clients.length === 0) {
      Room.rooms.delete(this.id);
    }
    return null;
  }

  emitToOthers(sender: Client | null, event: string, data?: unknown) {
    for (const client of this.clients) {
      if (client === sender) continue;
      client.emit(event, data);
    }
  }
}

webrtcWs.get(
  "/rooms/:id",
  upgradeWebSocket((c) => {
    const id = c.req.param("id");
    let client: Client | null = null;
    return {
      onOpen(evt, ws) {
        client = Room.createClient(id, ws);
        if (!client) return ws.close(4000, "Room is full");
        webrtcWsDebug(`room [${id}] added a connection`);
      },
      async onMessage(evt, ws) {
        if (!client) return;
        const { event, data } = JSON.parse(
          evt.data instanceof Blob
            ? await evt.data.text()
            : typeof evt.data === "string"
            ? evt.data
            : new TextDecoder().decode(evt.data)
        );
        if (typeof event !== "string") return;
        webrtcWsDebug(`room [${id}] event:`, event);
        client.on(event, data);
      },
      onError(evt, ws) {
        webrtcWsDebug(`room [${id}] connection error: ${evt}`);
      },
      onClose(evt, ws) {
        if (client?.leave()) webrtcWsDebug(`room [${id}] removed a connection`);
      },
    };
  })
);

export default webrtcWs;
