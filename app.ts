import fs from "fs";
import { config as dotenv } from "dotenv";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { cors } from "hono/cors";
import { serveStatic } from "hono/serve-static";
import createDebug from "debug";

dotenv();

export const debug = createDebug("boot");

export const app = new Hono();

export const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({
  app,
});

app.use(
  "*",
  cors({
    origin: [
      "http://127.0.0.1:5500",
      "http://localhost:5500",
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "http://localhost:8080",
      "http://127.0.0.1:8080",
    ],
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(
  "/*",
  serveStatic({
    root: "./public",
    getContent: async (path) => {
      if (fs.existsSync(path) && fs.statSync(path).isFile()) {
        return fs.readFileSync(path);
      }
      return null;
    },
    onFound: (_path, c) => {
      c.header(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, max-age=0"
      );
      c.header("Pragma", "no-cache");
      c.header("Expires", "0");
    },
  })
);

app.get("/", (c) => {
  return new Promise<Response>((resolve) => {
    fs.readFile("public/index.html", "utf-8", (error, data) => {
      if (error) resolve(c.body(null, 404));
      else resolve(c.html(data, 200));
    });
  });
});

app.onError((err, c) => {
  debug("app error:", err);
  return c.text("Service Unavailable", 503);
});
