import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { folders, messages, threads, users } from "../db/schema.js";
import { listPushSubscriptionsForUser } from "../notifier/subscriptions.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

/**
 * `/push/config`, `/push/subscriptions`, and the direct-apply
 * `/notifications/actions` route (#53, ADR-0015).
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

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
}

function buildTestApp(vapidPublicKey: string | null = null) {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    mailAccountVerify: async () => ({ ok: true }),
    vapidPublicKey,
  });
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

/** The single Owner every `claimOwner`-ed test app has — the id `listPushSubscriptionsForUser` scopes by. */
async function ownerUserId(): Promise<string> {
  const [owner] = await db.select({ id: users.id }).from(users).limit(1);
  if (!owner) throw new Error("expected an Owner to exist");
  return owner.id;
}

/** A Thread with one Inbox Message, plus the Archive folder `archive`/`trash`'s target-folder lookup needs to actually apply. */
async function insertThreadWithInboxMessage(
  mailAccountId: string,
  threadId: string,
): Promise<void> {
  await db.insert(threads).values({ id: threadId, mailAccountId, inInbox: true });
  const folderId = randomUUID();
  await db.insert(folders).values({
    id: folderId,
    mailAccountId,
    path: "INBOX",
    name: "INBOX",
    role: "inbox",
  });
  await db.insert(folders).values({
    id: randomUUID(),
    mailAccountId,
    path: "Archive",
    name: "Archive",
    role: "archive",
  });
  await db.insert(messages).values({
    id: randomUUID(),
    mailAccountId,
    threadId,
    folderId,
    uid: 1,
    subject: "Test",
    sentAt: new Date("2026-01-01T00:00:00Z"),
    receivedAt: new Date("2026-01-01T00:00:00Z"),
  });
}

describe("GET /push/config", () => {
  it("answers null when the operator has never generated a VAPID keypair", async () => {
    const app = buildTestApp(null);
    const cookie = await claimOwner(app);
    const response = await app.inject({ method: "GET", url: "/push/config", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ vapidPublicKey: null });
  });

  it("answers the configured public key otherwise", async () => {
    const app = buildTestApp("test-public-key");
    const cookie = await claimOwner(app);
    const response = await app.inject({ method: "GET", url: "/push/config", headers: { cookie } });
    expect(response.json()).toEqual({ vapidPublicKey: "test-public-key" });
  });

  it("requires a session", async () => {
    const app = buildTestApp("test-public-key");
    const response = await app.inject({ method: "GET", url: "/push/config" });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST/DELETE /push/subscriptions", () => {
  it("registers a subscription against the signed-in User", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);

    const response = await app.inject({
      method: "POST",
      url: "/push/subscriptions",
      headers: { cookie },
      payload: {
        endpoint: "https://push.example.test/abc",
        keys: { p256dh: "p256dh-value", auth: "auth-value" },
      },
    });
    expect(response.statusCode).toBe(204);

    const userId = await ownerUserId();
    const subscriptions = await listPushSubscriptionsForUser(db, userId);
    expect(subscriptions.map((row) => row.endpoint)).toEqual(["https://push.example.test/abc"]);
  });

  it("upserts on a re-registered endpoint rather than duplicating", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const endpoint = "https://push.example.test/same-endpoint";

    for (const auth of ["first-auth", "second-auth"]) {
      const response = await app.inject({
        method: "POST",
        url: "/push/subscriptions",
        headers: { cookie },
        payload: { endpoint, keys: { p256dh: "p256dh-value", auth } },
      });
      expect(response.statusCode).toBe(204);
    }

    const userId = await ownerUserId();
    const subscriptions = await listPushSubscriptionsForUser(db, userId);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.auth).toBe("second-auth");
  });

  it("removes a subscription on DELETE", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const endpoint = "https://push.example.test/to-remove";
    await app.inject({
      method: "POST",
      url: "/push/subscriptions",
      headers: { cookie },
      payload: { endpoint, keys: { p256dh: "p256dh-value", auth: "auth-value" } },
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/push/subscriptions",
      headers: { cookie },
      payload: { endpoint },
    });
    expect(response.statusCode).toBe(204);
  });

  it("rejects an invalid endpoint", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/push/subscriptions",
      headers: { cookie },
      payload: { endpoint: "not-a-url", keys: { p256dh: "x", auth: "y" } },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /notifications/actions", () => {
  it("archives a Thread directly, bypassing the Client's mutation queue", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    const threadId = randomUUID();
    await insertThreadWithInboxMessage(mailAccountId, threadId);

    const response = await app.inject({
      method: "POST",
      url: "/notifications/actions",
      headers: { cookie },
      payload: { id: randomUUID(), mailAccountId, intent: { type: "archive", threadId } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "applied" });

    const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread?.inInbox).toBe(false);
  });

  it("replays the same outcome for a retried id (Background Sync's retry path)", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    const threadId = randomUUID();
    await insertThreadWithInboxMessage(mailAccountId, threadId);
    const id = randomUUID();

    const first = await app.inject({
      method: "POST",
      url: "/notifications/actions",
      headers: { cookie },
      payload: { id, mailAccountId, intent: { type: "archive", threadId } },
    });
    const second = await app.inject({
      method: "POST",
      url: "/notifications/actions",
      headers: { cookie },
      payload: { id, mailAccountId, intent: { type: "archive", threadId } },
    });
    expect(first.json()).toEqual({ status: "applied" });
    expect(second.json()).toEqual({ status: "applied" });
  });

  it("404s for a Mail Account this User doesn't own", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/notifications/actions",
      headers: { cookie },
      payload: {
        id: randomUUID(),
        mailAccountId: randomUUID(),
        intent: { type: "archive", threadId: randomUUID() },
      },
    });
    expect(response.statusCode).toBe(404);
  });
});
