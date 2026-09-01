import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { recordCorrespondentActivity } from "../sync/correspondents.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

/**
 * `GET /correspondents/search` (#49): compose-spec's "queries the backend in
 * parallel for the long tail" — a plain fetch-through read over every
 * Correspondent an account has, scoped so one User can never search
 * another's, or an account they don't own.
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

describe("GET /correspondents/search", () => {
  it("ranks matches by score, over both address and display name", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);

    await recordCorrespondentActivity(db, mailAccountId, [
      { address: "ann@example.com", name: "Ann Chen", direction: "sent", at: new Date() },
    ]);
    await recordCorrespondentActivity(db, mailAccountId, [
      { address: "annette@example.com", name: null, direction: "received", at: new Date() },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/correspondents/search?mailAccountId=${mailAccountId}&q=ann`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { correspondents: { address: string }[] };
    expect(body.correspondents.map((c) => c.address)).toEqual([
      "ann@example.com",
      "annette@example.com",
    ]);
  });

  it("matches on display name too", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);

    await recordCorrespondentActivity(db, mailAccountId, [
      { address: "someone@example.com", name: "Bo Beckett", direction: "sent", at: new Date() },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/correspondents/search?mailAccountId=${mailAccountId}&q=beckett`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { correspondents: { address: string }[] };
    expect(body.correspondents.map((c) => c.address)).toEqual(["someone@example.com"]);
  });

  it("404s a Mail Account this User does not own", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);

    const response = await app.inject({
      method: "GET",
      url: "/correspondents/search?mailAccountId=not-mine&q=ann",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s a missing or empty query", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const mailAccountId = await createOwnedMailAccount(app, cookie);

    const response = await app.inject({
      method: "GET",
      url: `/correspondents/search?mailAccountId=${mailAccountId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it("401s without a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/correspondents/search?mailAccountId=x&q=ann",
    });
    expect(response.statusCode).toBe(401);
  });
});
