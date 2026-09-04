import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { mailAccounts, users } from "../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

/**
 * The Blob Store's HTTP surface (#48): upload/download/delete over
 * `app.inject`, the same shape `routes/messages.test.ts` uses. The MIME
 * assembly and the send-time blob lifecycle are `send.greenmail.test.ts`'s;
 * this is ownership, the live budget re-check, and the plain CRUD.
 */

const PUBLIC_URL = "http://localhost:3000";

let db: Db;
let closeDb: () => Promise<void>;

function buildTestApp(attachmentBudgetBytes?: number) {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    mailAccountVerify: async () => ({ ok: true, serverKind: "generic" }),
    attachmentBudgetBytes,
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

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

describe("POST /compositions/:compositionId/attachments", () => {
  it("uploads bytes, creating the Composition row lazily, and returns the attachment's metadata", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);

    const response = await app.inject({
      method: "POST",
      url: `/compositions/comp-1/attachments?mailAccountId=${mailAccountId}&filename=hello.txt&mimeType=text%2Fplain`,
      headers: { cookie, "content-type": "text/plain" },
      payload: Buffer.from("hello world"),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      filename: "hello.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
      disposition: "attachment",
      contentId: null,
    });
    expect(typeof body.id).toBe("string");
  });

  it("mints a contentId for an inline attachment", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);

    const response = await app.inject({
      method: "POST",
      url: `/compositions/comp-1/attachments?mailAccountId=${mailAccountId}&filename=a.png&mimeType=image%2Fpng&disposition=inline`,
      headers: { cookie, "content-type": "image/png" },
      payload: Buffer.from("fake png"),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().contentId).toBeTruthy();
  });

  it("rejects an unauthenticated upload", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/compositions/comp-1/attachments?mailAccountId=acct-1&filename=x.txt",
      headers: { "content-type": "text/plain" },
      payload: Buffer.from("x"),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a Mail Account this User does not own", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/compositions/comp-1/attachments?mailAccountId=not-mine&filename=x.txt",
      headers: { cookie, "content-type": "text/plain" },
      payload: Buffer.from("x"),
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects over the live budget, naming the remaining space (compose-spec)", async () => {
    // A tiny budget so a small payload is already over it.
    const app = buildTestApp(10);
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);

    const response = await app.inject({
      method: "POST",
      url: `/compositions/comp-1/attachments?mailAccountId=${mailAccountId}&filename=big.bin`,
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(100),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: "attachment_budget_exceeded",
      remainingBytes: 10,
      budgetBytes: 10,
    });
  });
});

describe("GET and DELETE /compositions/:compositionId/attachments/:attachmentId", () => {
  async function upload(app: FastifyInstance, cookie: string, mailAccountId: string) {
    const response = await app.inject({
      method: "POST",
      url: `/compositions/comp-1/attachments?mailAccountId=${mailAccountId}&filename=hi.txt&mimeType=text%2Fplain`,
      headers: { cookie, "content-type": "text/plain" },
      payload: Buffer.from("hi there"),
    });
    return response.json() as { id: string };
  }

  it("downloads the exact bytes back, with the filename and content type", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    const meta = await upload(app, cookie, mailAccountId);

    const response = await app.inject({
      method: "GET",
      url: `/compositions/comp-1/attachments/${meta.id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain");
    expect(response.body).toBe("hi there");
  });

  it("requires a session to download, before anything about ownership is even checked", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    const meta = await upload(app, cookie, mailAccountId);

    // A second User exists, owning no Mail Account this attachment could
    // belong to — present so the ownership check has something real to run
    // against once a login-as helper exists in this suite; the assertion
    // below is the one this route can make without one: unauthenticated is
    // unauthenticated regardless of whose attachment id is in the URL.
    const otherUserId = randomUUID();
    await db.insert(users).values({
      id: otherUserId,
      username: `other-${otherUserId.slice(0, 8)}`,
      passwordHash: "not-a-real-hash",
      role: "member",
    });
    await db.insert(mailAccounts).values({
      id: randomUUID(),
      userId: otherUserId,
      emailAddress: "other@example.com",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecurity: "tls",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpSecurity: "starttls",
      username: "other@example.com",
      credential: {
        kind: "password",
        secret: { keyVersion: 1, iv: "", ciphertext: "", authTag: "" },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/compositions/comp-1/attachments/${meta.id}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("deletes the blob and its metadata entry together", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    const meta = await upload(app, cookie, mailAccountId);

    const del = await app.inject({
      method: "DELETE",
      url: `/compositions/comp-1/attachments/${meta.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: `/compositions/comp-1/attachments/${meta.id}`,
      headers: { cookie },
    });
    expect(after.statusCode).toBe(404);
  });

  it("404s deleting an id that never existed", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);
    await upload(app, cookie, mailAccountId);

    const del = await app.inject({
      method: "DELETE",
      url: "/compositions/comp-1/attachments/not-a-real-id",
      headers: { cookie },
    });
    expect(del.statusCode).toBe(404);
  });
});
