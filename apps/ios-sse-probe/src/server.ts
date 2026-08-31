// Minimal, dependency-free SSE probe for wayfinder ticket #28:
// https://github.com/vicvancooten/mail/issues/28
//
// Serves a tiny installable PWA (public/) whose only job is to hold open an
// EventSource against /events and log, on-screen, whether the connection
// survives iOS backgrounding a Home-Screen-installed app. Heartbeat cadence
// (~25s) matches ADR-0015's assumed SSE heartbeat.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8791);
const HEARTBEAT_MS = 25_000;
const PUBLIC_DIR = join(fileURLToPath(import.meta.url), "..", "..", "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (path.includes("..")) return false;

  try {
    const filePath = join(PUBLIC_DIR, path);
    const body = await readFile(filePath);
    const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function serveEvents(req: IncomingMessage, res: ServerResponse): void {
  const clientId = Math.random().toString(36).slice(2, 8);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let seq = 0;
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send("hello", { clientId, serverTime: new Date().toISOString(), heartbeatMs: HEARTBEAT_MS });
  log(`connect  client=${clientId}`);

  const timer = setInterval(() => {
    seq += 1;
    send("heartbeat", { clientId, seq, serverTime: new Date().toISOString() });
    log(`heartbeat client=${clientId} seq=${seq}`);
  }, HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(timer);
    log(`disconnect client=${clientId} after seq=${seq}`);
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/events") {
    serveEvents(req, res);
    return;
  }
  void serveStatic(req, res).then((served) => {
    if (!served) {
      res.writeHead(404);
      res.end("not found");
    }
  });
});

server.listen(PORT, () => {
  log(
    `ios-sse-probe listening on http://0.0.0.0:${PORT} (heartbeat every ${HEARTBEAT_MS / 1000}s)`,
  );
  log(
    "expose over HTTPS reachable from the phone (Tailscale Funnel / cloudflared / ngrok) — see README.md",
  );
});
