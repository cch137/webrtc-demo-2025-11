import { serve } from "@hono/node-server";

import webrtcDss from "./services/webrtc-signaling-dss";
import webrtcWs from "./services/webrtc-signaling-ws";
import { app, debug, injectWebSocket } from "./app";

app.route("", webrtcDss);
app.route("", webrtcWs);

process.on("uncaughtException", (error) => {
  debug("uncaughtException:", error);
});

process.on("unhandledRejection", (error) => {
  debug("unhandledRejection:", error);
});

const port =
  (process.env.PORT && Number.parseInt(process.env.PORT, 10)) || 3000;

const server = serve({ fetch: app.fetch, port }, (info) => {
  debug(`online @ http://localhost:${info.port}`);
});

injectWebSocket(server);
