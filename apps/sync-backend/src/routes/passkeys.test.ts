import type { FastifyInstance } from "fastify";
import { WebAuthnEmulator } from "nid-webauthn-emulator";
import { generate } from "otplib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

const PUBLIC_URL = "http://localhost:3000";
// The RP origin the emulator "browses" from — has to match PUBLIC_URL's
// origin, the way a real browser's origin has to match where the page was
// served from.
const ORIGIN = PUBLIC_URL;

let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;

function parseCookie(raw: string): [string, string] {
  const pair = raw.split(";")[0] ?? raw;
  const eq = pair.indexOf("=");
  return [pair.slice(0, eq), pair.slice(eq + 1)];
}

/** Merges every Set-Cookie header from one or more responses into an inject()-ready cookie jar. */
function cookieJar(...headers: Array<string | string[] | undefined>): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const header of headers) {
    if (!header) continue;
    for (const raw of Array.isArray(header) ? header : [header]) {
      const [name, value] = parseCookie(raw);
      jar[name] = value;
    }
  }
  return jar;
}

/** Reads the raw claim token the way an operator would: off the boot log line. */
async function mintAndCaptureToken(): Promise<string> {
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
  if (!captured) throw new Error("ensureClaimToken did not log a claimToken");
  return captured;
}

async function claimOwner(): Promise<Record<string, string>> {
  const token = await mintAndCaptureToken();
  const response = await app.inject({
    method: "POST",
    url: "/auth/claim",
    payload: { token, username: "vic", password: "a-long-enough-password" },
  });
  return cookieJar(response.headers["set-cookie"]);
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

/**
 * Drives one real passkey registration ceremony end to end — using
 * `nid-webauthn-emulator` as a software CTAP2 authenticator, this exercises
 * the actual `@simplewebauthn/server` verification and DB write, not a
 * stand-in for them.
 */
async function registerPasskey(emulator: WebAuthnEmulator, sessionCookies: Record<string, string>) {
  const options = await app.inject({
    method: "POST",
    url: "/auth/passkeys/register/options",
    cookies: sessionCookies,
  });
  expect(options.statusCode).toBe(200);

  const credential = emulator.createJSON(ORIGIN, options.json());
  const challengeCookies = cookieJar(options.headers["set-cookie"]);

  return app.inject({
    method: "POST",
    url: "/auth/passkeys/register/verify",
    cookies: { ...sessionCookies, ...challengeCookies },
    payload: { response: credential },
  });
}

/** Drives one real, usernameless passkey login ceremony end to end. */
async function loginWithPasskey(emulator: WebAuthnEmulator) {
  const options = await app.inject({ method: "POST", url: "/auth/passkeys/login/options" });
  expect(options.statusCode).toBe(200);

  const credential = emulator.getJSON(ORIGIN, options.json());
  const challengeCookies = cookieJar(options.headers["set-cookie"]);

  return app.inject({
    method: "POST",
    url: "/auth/passkeys/login/verify",
    cookies: challengeCookies,
    payload: { response: credential },
  });
}

describe("passkey registration", () => {
  it("requires a session", async () => {
    const response = await app.inject({ method: "POST", url: "/auth/passkeys/register/options" });
    expect(response.statusCode).toBe(401);
  });

  it("registers a passkey and lists it for the owning user", async () => {
    const sessionCookies = await claimOwner();
    const emulator = new WebAuthnEmulator();

    const verify = await registerPasskey(emulator, sessionCookies);
    expect(verify.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/auth/passkeys",
      cookies: sessionCookies,
    });
    expect(list.json().passkeys).toHaveLength(1);
  });

  it("refuses to verify without ever fetching options (no challenge cookie)", async () => {
    const sessionCookies = await claimOwner();
    const emulator = new WebAuthnEmulator();
    const options = await app.inject({
      method: "POST",
      url: "/auth/passkeys/register/options",
      cookies: sessionCookies,
    });
    const credential = emulator.createJSON(ORIGIN, options.json());

    const verify = await app.inject({
      method: "POST",
      url: "/auth/passkeys/register/verify",
      cookies: sessionCookies, // challenge cookie deliberately omitted
      payload: { response: credential },
    });
    expect(verify.statusCode).toBe(400);
  });

  it("lets the owning user remove a passkey", async () => {
    const sessionCookies = await claimOwner();
    const emulator = new WebAuthnEmulator();
    await registerPasskey(emulator, sessionCookies);

    const [passkey] = (
      await app.inject({ method: "GET", url: "/auth/passkeys", cookies: sessionCookies })
    ).json().passkeys;

    const remove = await app.inject({
      method: "DELETE",
      url: `/auth/passkeys/${passkey.id}`,
      cookies: sessionCookies,
    });
    expect(remove.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/auth/passkeys",
      cookies: sessionCookies,
    });
    expect(list.json().passkeys).toHaveLength(0);
  });
});

describe("passkey login", () => {
  it("logs in with a registered passkey — usernameless, no password involved", async () => {
    const sessionCookies = await claimOwner();
    const emulator = new WebAuthnEmulator();
    await registerPasskey(emulator, sessionCookies);

    const login = await loginWithPasskey(emulator);

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ user: { username: "vic" } });
    const newSessionCookies = cookieJar(login.headers["set-cookie"]);

    const session = await app.inject({
      method: "GET",
      url: "/auth/session",
      cookies: newSessionCookies,
    });
    expect(session.statusCode).toBe(200);
  });

  it("rejects a passkey nobody registered", async () => {
    await claimOwner();
    // An emulator that never went through /auth/passkeys/register/verify —
    // its credential id has no matching row.
    const strangerEmulator = new WebAuthnEmulator();
    const options = await app.inject({ method: "POST", url: "/auth/passkeys/login/options" });
    const challengeCookies = cookieJar(options.headers["set-cookie"]);
    const credential = strangerEmulator.getJSON(ORIGIN, options.json());

    const login = await app.inject({
      method: "POST",
      url: "/auth/passkeys/login/verify",
      cookies: challengeCookies,
      payload: { response: credential },
    });
    expect(login.statusCode).toBe(401);
  });

  it("still asks for a TOTP code when the owner has 2FA enrolled", async () => {
    const sessionCookies = await claimOwner();
    const emulator = new WebAuthnEmulator();
    await registerPasskey(emulator, sessionCookies);

    const enroll = await app.inject({
      method: "POST",
      url: "/auth/totp/enroll",
      cookies: sessionCookies,
    });
    const { secret } = enroll.json();
    await app.inject({
      method: "POST",
      url: "/auth/totp/confirm",
      cookies: sessionCookies,
      payload: { code: await generate({ secret }) },
    });

    const login = await loginWithPasskey(emulator);
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ totpRequired: true });
    // A Set-Cookie clearing the spent challenge cookie is expected; no
    // session cookie is — the whole point of the totpRequired branch.
    expect(cookieJar(login.headers["set-cookie"])).not.toHaveProperty("mail_session");
  });
});
