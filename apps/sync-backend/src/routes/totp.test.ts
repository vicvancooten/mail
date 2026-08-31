import type { FastifyInstance } from "fastify";
import { generate } from "otplib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * A code for one otplib time step past `secret`'s current one — distinct
 * from a code generated microseconds earlier (e.g. to confirm enrollment),
 * yet still inside `verifyTotpCode`'s ±30s tolerance. Without this, two
 * codes generated back-to-back in a test would usually land in the very
 * same time step and collide with the replay guard.
 */
function nextStepCode(secret: string): Promise<string> {
  return generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
}

import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";

const PUBLIC_URL = "http://localhost:3000";

let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;

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
  app = buildApp({ db, publicUrl: PUBLIC_URL });
});

afterAll(async () => {
  await closeDb?.();
});

describe("GET /auth/totp/status", () => {
  it("requires a session", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/totp/status" });
    expect(response.statusCode).toBe(401);
  });

  it("reports disabled with no enrollment", async () => {
    const cookie = await claimOwner();
    const response = await app.inject({
      method: "GET",
      url: "/auth/totp/status",
      headers: { cookie },
    });
    expect(response.json()).toEqual({ enabled: false });
  });
});

describe("TOTP enroll → confirm → disable", () => {
  it("enrolls, then confirms with the correct code", async () => {
    const cookie = await claimOwner();

    const enroll = await app.inject({
      method: "POST",
      url: "/auth/totp/enroll",
      headers: { cookie },
    });
    expect(enroll.statusCode).toBe(200);
    const { secret, otpauthUrl } = enroll.json();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(otpauthUrl).toContain(secret);

    // Not enabled until confirmed.
    const beforeConfirm = await app.inject({
      method: "GET",
      url: "/auth/totp/status",
      headers: { cookie },
    });
    expect(beforeConfirm.json()).toEqual({ enabled: false });

    const confirm = await app.inject({
      method: "POST",
      url: "/auth/totp/confirm",
      headers: { cookie },
      payload: { code: await generate({ secret }) },
    });
    expect(confirm.statusCode).toBe(200);

    const afterConfirm = await app.inject({
      method: "GET",
      url: "/auth/totp/status",
      headers: { cookie },
    });
    expect(afterConfirm.json()).toEqual({ enabled: true });
  });

  it("rejects confirming with the wrong code", async () => {
    const cookie = await claimOwner();
    await app.inject({ method: "POST", url: "/auth/totp/enroll", headers: { cookie } });

    const confirm = await app.inject({
      method: "POST",
      url: "/auth/totp/confirm",
      headers: { cookie },
      payload: { code: "000000" },
    });
    expect(confirm.statusCode).toBe(401);
  });

  it("refuses a second enrollment while one is already confirmed", async () => {
    const cookie = await claimOwner();
    const enroll = await app.inject({
      method: "POST",
      url: "/auth/totp/enroll",
      headers: { cookie },
    });
    const { secret } = enroll.json();
    await app.inject({
      method: "POST",
      url: "/auth/totp/confirm",
      headers: { cookie },
      payload: { code: await generate({ secret }) },
    });

    const reenroll = await app.inject({
      method: "POST",
      url: "/auth/totp/enroll",
      headers: { cookie },
    });
    expect(reenroll.statusCode).toBe(409);
  });

  it("disables with the current code, and login stops asking for one", async () => {
    const cookie = await claimOwner();
    const enroll = await app.inject({
      method: "POST",
      url: "/auth/totp/enroll",
      headers: { cookie },
    });
    const { secret } = enroll.json();
    await app.inject({
      method: "POST",
      url: "/auth/totp/confirm",
      headers: { cookie },
      payload: { code: await generate({ secret }) },
    });

    const disable = await app.inject({
      method: "POST",
      url: "/auth/totp/disable",
      headers: { cookie },
      payload: { code: await nextStepCode(secret) },
    });
    expect(disable.statusCode).toBe(204);

    const status = await app.inject({
      method: "GET",
      url: "/auth/totp/status",
      headers: { cookie },
    });
    expect(status.json()).toEqual({ enabled: false });

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "vic", password: "a-long-enough-password" },
    });
    expect(login.json()).toMatchObject({ user: { username: "vic" } });
  });

  it("refuses to disable with the wrong code", async () => {
    const cookie = await claimOwner();
    const enroll = await app.inject({
      method: "POST",
      url: "/auth/totp/enroll",
      headers: { cookie },
    });
    const { secret } = enroll.json();
    await app.inject({
      method: "POST",
      url: "/auth/totp/confirm",
      headers: { cookie },
      payload: { code: await generate({ secret }) },
    });

    const disable = await app.inject({
      method: "POST",
      url: "/auth/totp/disable",
      headers: { cookie },
      payload: { code: "000000" },
    });
    expect(disable.statusCode).toBe(401);

    const status = await app.inject({
      method: "GET",
      url: "/auth/totp/status",
      headers: { cookie },
    });
    expect(status.json()).toEqual({ enabled: true });
  });
});
