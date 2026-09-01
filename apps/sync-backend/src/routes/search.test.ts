import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { folders, messages, threads } from "../db/schema.js";
import { reindexMessages } from "../sync/search-index.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

/**
 * `POST /search` (#50, ADR-0016, `docs/search-ux-spec.md`): the HTTP layer —
 * auth, Mail Account ownership, and assembling the wire shape (Thread
 * projection, folder pill, Index Watermark) around `sync/search-query.ts`'s
 * ranking, which `sync/search-query.test.ts` covers in depth.
 */

const PUBLIC_URL = "http://localhost:3000";

let db: Db;
let closeDb: () => Promise<void>;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

function buildTestApp() {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    mailAccountVerify: async () => ({ ok: true }),
  });
}

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
}

async function claimOwner(app: FastifyInstance): Promise<string> {
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

async function createOwnedMailAccount(app: FastifyInstance, cookie: string): Promise<string> {
  const response = await app.inject({
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
  expect(response.statusCode).toBe(201);
  return (response.json().mailAccount as { id: string }).id;
}

async function seedInboxMessage(
  mailAccountId: string,
  overrides: { subject?: string; fromAddress?: string; bodyText?: string | null } = {},
): Promise<{ threadId: string; folderId: string }> {
  const threadId = randomUUID();
  const folderId = randomUUID();
  await db.insert(threads).values({ id: threadId, mailAccountId });
  await db
    .insert(folders)
    .values({ id: folderId, mailAccountId, path: "INBOX", name: "INBOX", role: "inbox" });
  const messageId = randomUUID();
  await db.insert(messages).values({
    id: messageId,
    mailAccountId,
    threadId,
    folderId,
    uid: 1,
    subject: overrides.subject ?? "Quarterly budget",
    fromName: "Vic van Cooten",
    fromAddress: overrides.fromAddress ?? "vic.van.cooten@a-insights.eu",
    sentAt: new Date("2024-06-15T00:00:00Z"),
    receivedAt: new Date("2024-06-15T00:00:00Z"),
    bodyText: overrides.bodyText ?? null,
  });
  await reindexMessages(db, [messageId]);
  return { threadId, folderId };
}

describe("POST /search", () => {
  it("401s without a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/search",
      payload: { mailAccountId: "x", text: "hello" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s a Mail Account this User does not own", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/search",
      headers: { cookie },
      payload: { mailAccountId: "not-mine", text: "hello" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s a request missing mailAccountId", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/search",
      headers: { cookie },
      payload: { text: "hello" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("finds mail by a sender's address local part, and carries the Thread projection, folder pill and Index Watermark", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    const { threadId, folderId } = await seedInboxMessage(mailAccountId, {
      fromAddress: "kowalski0@a-insights.eu",
    });

    const response = await app.inject({
      method: "POST",
      url: "/search",
      headers: { cookie },
      payload: { mailAccountId, text: "kowalski0" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      results: {
        thread: { id: string };
        matchedMessageId: string;
        folder: { id: string; role: string | null };
      }[];
      cursor: string | null;
      indexWatermark: { coveredSince: string | null; complete: boolean };
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.thread.id).toBe(threadId);
    expect(body.results[0]?.folder).toEqual({ id: folderId, name: "INBOX", role: "inbox" });
    expect(body.cursor).toBeNull();
    expect(body.indexWatermark).toEqual({ coveredSince: null, complete: false });
  });

  it("returns no results, not an error, for a query nothing matches", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    await seedInboxMessage(mailAccountId);

    const response = await app.inject({
      method: "POST",
      url: "/search",
      headers: { cookie },
      payload: { mailAccountId, text: "nomatch" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ results: [], cursor: null });
  });
});
