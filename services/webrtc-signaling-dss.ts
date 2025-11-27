// app.ts
import { Hono } from "hono";
import createDebug from "debug";

import { stringifyError } from "../lib/utils/error-handle";

const webrtcDssDebug = createDebug("webrtc-dss");
const webrtcDssBodyDebug = webrtcDssDebug.extend("body");

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const INACTIVITY_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_QUEUE_SIZE = 64; // max records per queue
const MAX_POST_DATA_BYTES = 64 * 1024; // 64 KB

export class RelayQueue<T = unknown> {
  private readonly items: T[] = [];
  public readonly createdAtMs: number;
  private _lastUpdatedAtMs: number;

  get size() {
    return this.items.length;
  }

  get lastUpdatedAtMs() {
    return this._lastUpdatedAtMs;
  }

  constructor() {
    const now = Date.now();
    this.createdAtMs = now;
    this._lastUpdatedAtMs = now;
  }

  push(payload: T): void {
    if (this.items.length >= MAX_QUEUE_SIZE) {
      throw new Error("Queue is full");
    }
    this.items.push(payload);
    this.touch();
  }

  pop(): T | undefined {
    this.touch();
    return this.items.shift();
  }

  popAll(): T[] {
    this.touch();
    return this.items.splice(0);
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  private touch() {
    this._lastUpdatedAtMs = Date.now();
  }
}

export class RelayStore<T = unknown> {
  private readonly queues = new Map<string, RelayQueue<T>>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private destroyed = false;

  constructor(
    private readonly inactivityTtlMs: number,
    cleanupIntervalMs: number
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
  }

  sizeOf(id: string): number {
    return this.queues.get(id)?.size ?? 0;
  }

  push(id: string, payload: T): void {
    if (this.destroyed) {
      throw new Error("Store is destroyed");
    }

    let queue = this.queues.get(id);
    if (!queue) {
      queue = new RelayQueue<T>();
      this.queues.set(id, queue);
    }
    queue.push(payload);
  }

  pop(id: string): T | undefined {
    if (this.destroyed) {
      throw new Error("Store is destroyed");
    }

    const queue = this.queues.get(id);
    if (!queue) return undefined;

    const payload = queue.pop();
    if (queue.isEmpty()) {
      this.queues.delete(id);
    }
    return payload;
  }

  popAll(id: string): T[] | null {
    if (this.destroyed) {
      throw new Error("Store is destroyed");
    }
    const queue = this.queues.get(id);
    if (!queue) return null;
    const payloads = queue.popAll();
    this.queues.delete(id);
    return payloads;
  }

  delete(id: string) {
    if (this.destroyed) {
      throw new Error("Store is destroyed");
    }

    return this.queues.delete(id);
  }

  private cleanup() {
    const now = Date.now();
    for (const [id, queue] of this.queues.entries()) {
      if (now - queue.lastUpdatedAtMs >= this.inactivityTtlMs) {
        this.queues.delete(id);
      }
    }
  }

  get isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.queues.clear();
    clearInterval(this.cleanupTimer);
    this.destroyed = true;
  }
}

export const store = new RelayStore<unknown>(
  INACTIVITY_TTL_MS,
  CLEANUP_INTERVAL_MS
);

const webrtcDss = new Hono();

// simple logger: :method :url :status :res[content-length] - :response-time ms
webrtcDss.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;

  const method = c.req.method;
  const url = c.req.url;
  const status = c.res.status;
  const contentLength = c.res.headers.get("content-length") ?? "0";

  webrtcDssDebug(`${method} ${url} ${status} ${contentLength} - ${ms} ms`);
});

// POST /data/:id  (JSON only)
webrtcDss.post("/data/:id", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > MAX_POST_DATA_BYTES) {
    return c.json({ error: "Payload too large" }, 413);
  }

  let body: unknown;
  try {
    body = await c.req.json();
    webrtcDssBodyDebug(body);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  try {
    const id = c.req.param("id");
    store.push(id, body);
    return c.body(null, 200);
  } catch (error) {
    return c.json({ error: stringifyError(error) }, 500);
  }
});

// GET /data/:id
webrtcDss.get("/data/:id", (c) => {
  const id = c.req.param("id");
  const notFrom = c.req.query("not_from");
  const array = Boolean(c.req.query("array"));

  try {
    if (array) {
      const payloads = store.popAll(id);
      if (payloads === null || payloads.length === 0) {
        return c.body(null, 404);
      }
      return c.json(payloads, 200);
    }
    let i = store.sizeOf(id);
    while (i-- > 0) {
      const payload = store.pop(id);
      if (payload === undefined) continue;
      if (payload && typeof payload === "object") {
        if (
          notFrom !== undefined &&
          "from" in payload &&
          payload.from === notFrom
        ) {
          store.push(id, payload);
          continue;
        }
        if ("once" in payload && payload.once === true) {
          store.delete(id);
        }
      }
      return c.json(payload, 200);
    }
    return c.body(null, 404);
  } catch (error) {
    return c.json({ error: stringifyError(error) }, 500);
  }
});

// DELETE /data/:id
webrtcDss.delete("/data/:id", (c) => {
  const id = c.req.param("id");

  try {
    return c.json({ existed: store.delete(id) }, 200);
  } catch (error) {
    return c.json({ error: stringifyError(error) }, 500);
  }
});

export default webrtcDss;
