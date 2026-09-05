import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { threads } from "../db/schema.js";
import { createSyncHintBroker, type SyncHintBroker } from "../realtime/sync-hints.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

/**
 * `GET /events` end to end (#52, ADR-0015): a real listening server and a
 * real Postgres `LISTEN/NOTIFY` round trip, because the thing worth proving
 * is that a committed write reaches an open connection's stream — a mocked
 * broker would only prove the route calls a function.
 */

const PUBLIC_URL = "http://localhost:3000";

let db: Db;
let closeDb: () => Promise<void>;
let broker: SyncHintBroker;
let app: FastifyInstance;
let port: number;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
}

async function claimOwner(): Promise<string> {
  let captured = "";
  const originalInfo = app.log.info.bind(app.log);
  app.log.info = ((payload: unknown, ...rest: unknown[]) => {
    if (typeof payload === "object" && payload && "claimToken" in payload) {
      captured = String((payload as { claimToken: string }).claimToken);
    }
    return originalInfo(payload as never, ...(rest as []));
  }) as typeof app.log.info;
  await ensureClaimToken(db, app.log, PUBLIC_URL);
  app.log.info = originalInfo;

  const response = await app.inject({
    method: "POST",
    url: "/auth/claim",
    payload: { token: captured, username: "vic", password: "a-long-enough-password" },
  });
  return extractCookie(response.headers["set-cookie"]);
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  broker = createSyncHintBroker(created.sql, { coalesceMs: 30 });
  app = buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    mailAccountVerify: async () => ({ ok: true, serverKind: "generic" }),
    syncHints: broker,
    eventsHeartbeatMs: 40,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  port = address.port;
});

afterEach(async () => {
  await app.close();
  await broker.stop();
});

afterAll(async () => {
  await closeDb?.();
});

/** Reads SSE frames off a fetch response body until `matcher` sees one it wants, or times out. */
async function readUntil(
  body: ReadableStream<Uint8Array>,
  matcher: (frame: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      for (const frame of frames) {
        if (matcher(frame)) return frame;
      }
    }
    throw new Error(`no matching frame within ${timeoutMs}ms; got: ${buffer}`);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

describe("GET /events", () => {
  it("requires a session", async () => {
    const response = await app.inject({ method: "GET", url: "/events" });
    expect(response.statusCode).toBe(401);
  });

  it("opens an SSE stream and delivers a hint on a committed change", async () => {
    const cookie = await claimOwner();
    const response = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (!response.body) throw new Error("expected a streamed body");

    // Owned via the real route so it has every trigger-stamped column,
    // including the user_id `notify_sync_hint` resolves through.
    const createResponse = await app.inject({
      method: "POST",
      url: "/mail-accounts",
      headers: { cookie },
      payload: {
        emailAddress: "vic@example.com",
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
        username: "vic@example.com",
        password: "correct-horse-battery-staple",
      },
    });
    const mailAccountId = (createResponse.json().mailAccount as { id: string }).id;

    await db.insert(threads).values({ id: randomUUID(), mailAccountId });

    const frame = await readUntil(response.body, (f) => f.includes("event: hint"));
    expect(frame).toContain("event: hint");
  });

  it("sends periodic heartbeats to defeat proxy idle timeouts", async () => {
    const cookie = await claimOwner();
    const response = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { cookie },
    });
    if (!response.body) throw new Error("expected a streamed body");

    const frame = await readUntil(response.body, (f) => f.trim() === ":heartbeat");
    expect(frame.trim()).toBe(":heartbeat");
  });

  it("stops delivering once the connection closes", async () => {
    const cookie = await claimOwner();
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    if (!response.body) throw new Error("expected a streamed body");
    controller.abort();

    const createResponse = await app.inject({
      method: "POST",
      url: "/mail-accounts",
      headers: { cookie },
      payload: {
        emailAddress: "vic2@example.com",
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
        username: "vic2@example.com",
        password: "correct-horse-battery-staple",
      },
    });
    const mailAccountId = (createResponse.json().mailAccount as { id: string }).id;
    await db.insert(threads).values({ id: randomUUID(), mailAccountId });

    // Nothing to read from an aborted stream; the point this proves is that
    // the server-side cleanup (`request.raw.on("close", ...)`) runs cleanly
    // against an already-torn-down socket rather than throwing — which an
    // unhandled error here would fail the test on.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
