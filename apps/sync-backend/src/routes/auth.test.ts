import type { FastifyInstance } from "fastify";
import { generate } from "otplib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

const PUBLIC_URL = "http://localhost:3000";

let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
}

/** Reads the raw claim token the way an operator would: off the boot log line. */
async function mintAndCaptureToken(targetApp: FastifyInstance): Promise<string> {
  let captured = "";
  const originalInfo = targetApp.log.info.bind(targetApp.log);
  targetApp.log.info = ((payload: unknown, ...rest: unknown[]) => {
    if (typeof payload === "object" && payload && "claimToken" in payload) {
      captured = String((payload as { claimToken: string }).claimToken);
    }
    return originalInfo(payload as never, ...(rest as []));
  }) as typeof targetApp.log.info;

  await ensureClaimToken(db, targetApp.log, PUBLIC_URL);
  targetApp.log.info = originalInfo;

  if (!captured) throw new Error("ensureClaimToken did not log a claimToken");
  return captured;
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  app = buildApp({ db, publicUrl: PUBLIC_URL, mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });
});

afterAll(async () => {
  await closeDb?.();
});

describe("GET /auth/status", () => {
  it("reports unclaimed with no Owner", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/status" });
    expect(response.json()).toEqual({ claimed: false });
  });

  it("reports claimed once an Owner exists", async () => {
    const token = await mintAndCaptureToken(app);
    await app.inject({
      method: "POST",
      url: "/auth/claim",
      payload: { token, username: "vic", password: "a-long-enough-password" },
    });

    const response = await app.inject({ method: "GET", url: "/auth/status" });
    expect(response.json()).toEqual({ claimed: true });
  });
});

describe("first-run claim", () => {
  it("rejects a wrong token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/claim",
      payload: { token: "wrong", username: "vic", password: "a-long-enough-password" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("creates the Owner and signs them in on a valid token", async () => {
    const token = await mintAndCaptureToken(app);

    const response = await app.inject({
      method: "POST",
      url: "/auth/claim",
      payload: { token, username: "vic", password: "a-long-enough-password" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ user: { username: "vic", role: "owner" } });
    const cookie = extractCookie(response.headers["set-cookie"]);

    const sessionResponse = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json()).toMatchObject({ user: { username: "vic" } });
  });

  it("can't be replayed — a token works exactly once", async () => {
    const token = await mintAndCaptureToken(app);
    await app.inject({
      method: "POST",
      url: "/auth/claim",
      payload: { token, username: "vic", password: "a-long-enough-password" },
    });

    const replay = await app.inject({
      method: "POST",
      url: "/auth/claim",
      payload: { token, username: "someone-else", password: "another-long-password" },
    });
    expect(replay.statusCode).toBe(401);
  });
});

describe("login / logout round trip", () => {
  async function claimOwner() {
    const token = await mintAndCaptureToken(app);
    await app.inject({
      method: "POST",
      url: "/auth/claim",
      payload: { token, username: "vic", password: "a-long-enough-password" },
    });
  }

  it("rejects an unknown username", async () => {
    await claimOwner();
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "nope", password: "a-long-enough-password" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a wrong password", async () => {
    await claimOwner();
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "vic", password: "wrong-password" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("logs in, reaches an authenticated route, then logs out", async () => {
    await claimOwner();

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "vic", password: "a-long-enough-password" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = extractCookie(login.headers["set-cookie"]);

    const session = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    expect(session.statusCode).toBe(200);

    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("survives the app being rebuilt against the same database (a restart)", async () => {
    await claimOwner();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "vic", password: "a-long-enough-password" },
    });
    const cookie = extractCookie(login.headers["set-cookie"]);

    // Sessions are DB-backed, not in-process — a fresh app instance sharing
    // the same database is what a backend restart looks like from here.
    const restarted = buildApp({
      db,
      publicUrl: PUBLIC_URL,
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    });
    const session = await restarted.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
  });
});

describe("GET /auth/session", () => {
  it("requires a session", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/session" });
    expect(response.statusCode).toBe(401);
  });
});

describe("TOTP-gated login (#32)", () => {
  /**
   * A code for one otplib time step past `secret`'s current one — distinct
   * from whatever `generate({ secret })` just produced (e.g. to confirm
   * enrollment), yet still inside `verifyTotpCode`'s ±30s tolerance. Without
   * this, two codes generated microseconds apart in a test would usually
   * land in the very same time step and collide with the replay guard.
   */
  function nextStepCode(secret: string): Promise<string> {
    return generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
  }

  async function claimOwner(): Promise<string> {
    const token = await mintAndCaptureToken(app);
    const response = await app.inject({
      method: "POST",
      url: "/auth/claim",
      payload: { token, username: "vic", password: "a-long-enough-password" },
    });
    return extractCookie(response.headers["set-cookie"]);
  }

  /** Enrolls and confirms TOTP for the already-signed-in owner, returning the secret. */
  async function enableTotp(sessionCookie: string): Promise<string> {
    const enroll = await app.inject({
      method: "POST",
      url: "/auth/totp/enroll",
      headers: { cookie: sessionCookie },
    });
    const { secret } = enroll.json();

    const confirm = await app.inject({
      method: "POST",
      url: "/auth/totp/confirm",
      headers: { cookie: sessionCookie },
      payload: { code: await generate({ secret }) },
    });
    expect(confirm.statusCode).toBe(200);

    return secret;
  }

  it("password login untouched when TOTP isn't enrolled", async () => {
    await claimOwner();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "vic", password: "a-long-enough-password" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ user: { username: "vic" } });
    expect(login.headers["set-cookie"]).toBeDefined();
  });

  it("asks for a TOTP code once enrolled, and no session cookie is set yet", async () => {
    const sessionCookie = await claimOwner();
    await enableTotp(sessionCookie);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "vic", password: "a-long-enough-password" },
    });

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ totpRequired: true });
    expect(login.json().challengeToken).toEqual(expect.any(String));
    expect(login.headers["set-cookie"]).toBeUndefined();
  });

  it("completes login with the right code", async () => {
    const sessionCookie = await claimOwner();
    const secret = await enableTotp(sessionCookie);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "vic", password: "a-long-enough-password" },
    });
    const { challengeToken } = login.json();

    const totpLogin = await app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { challengeToken, code: await nextStepCode(secret) },
    });
    expect(totpLogin.statusCode).toBe(200);
    expect(totpLogin.json()).toMatchObject({ user: { username: "vic" } });

    const cookie = extractCookie(totpLogin.headers["set-cookie"]);
    const session = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    expect(session.statusCode).toBe(200);
  });

  it("rejects a wrong code without minting a session", async () => {
    const sessionCookie = await claimOwner();
    await enableTotp(sessionCookie);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "vic", password: "a-long-enough-password" },
    });
    const { challengeToken } = login.json();

    const totpLogin = await app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { challengeToken, code: "000000" },
    });
    expect(totpLogin.statusCode).toBe(401);
  });

  it("can't reuse a challenge token twice", async () => {
    const sessionCookie = await claimOwner();
    const secret = await enableTotp(sessionCookie);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "vic", password: "a-long-enough-password" },
    });
    const { challengeToken } = login.json();
    const code = await generate({ secret });

    await app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { challengeToken, code },
    });
    const replay = await app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { challengeToken, code },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("can't reuse the same code across two separate login challenges", async () => {
    const sessionCookie = await claimOwner();
    const secret = await enableTotp(sessionCookie);
    // A step past enableTotp's own confirmation code, which already spent its step.
    const code = await nextStepCode(secret);

    const loginA = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "vic", password: "a-long-enough-password" },
    });
    const loginB = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "vic", password: "a-long-enough-password" },
    });

    const first = await app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { challengeToken: loginA.json().challengeToken, code },
    });
    expect(first.statusCode).toBe(200);

    // Same code, a still-fresh (unused) challenge — this isolates the
    // TOTP replay guard from the challenge's own single-use consumption.
    const second = await app.inject({
      method: "POST",
      url: "/auth/login/totp",
      payload: { challengeToken: loginB.json().challengeToken, code },
    });
    expect(second.statusCode).toBe(401);
  });
});
