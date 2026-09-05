import { randomUUID } from "node:crypto";
import { OAUTH_SIGN_IN_OUTCOME_PARAM } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { createSession } from "../auth/sessions.js";
import type { Db } from "../db/client.js";
import { mailAccounts, oauthSignInAttempts, users } from "../db/schema.js";
import { deriveCredentialKey, sealSecret } from "../mail-accounts/credential-crypto.js";
import type {
  AuthorizationCallbackError,
  AuthorizationUrlInput,
  ExchangeCodeInput,
  ProviderAdapter,
  ProviderGrant,
} from "../mail-accounts/provider-adapter.js";
import { deriveCodeChallenge, startSignInAttempt } from "../mail-accounts/sign-in-attempts.js";
import type { verifyMailAccountCredentials } from "../mail-accounts/verify.js";
import {
  deleteProviderRegistration,
  upsertProviderRegistration,
} from "../provider-registrations/store.js";
import type { SyncManager } from "../sync/manager.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { defaultProviderAdapters } from "./oauth-signin.js";

/**
 * Sign in with Google to add a Mail Account (#116, ADR-0021), driven end to
 * end through an injected fake `ProviderAdapter` — the seam exists precisely
 * so the whole flow is exercisable without an OAuth endpoint. What the real
 * Google adapter puts in the URL and reads out of a token response is
 * `google-adapter.test.ts`'s job; this file is about the flow's own
 * decisions: single-use state, verify-before-save, and one outcome code per
 * way a sign-in can end.
 */

const PUBLIC_URL = "https://mail.example.test";
const GOOGLE_REDIRECT_URI = `${PUBLIC_URL}/auth/oauth/google/callback`;

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

/** The grant a happy-path fake exchange hands back — the address included, since ADR-0021 takes it from the Provider and never from the User. */
function fakeGrant(overrides: Partial<ProviderGrant> = {}): ProviderGrant {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scope: ["https://mail.google.com/", "email"],
    emailAddress: "someone@gmail.com",
    ...overrides,
  };
}

interface FakeAdapterOptions {
  exchange?: (input: ExchangeCodeInput) => Promise<ProviderGrant>;
  seen?: { authorization: AuthorizationUrlInput[]; exchange: ExchangeCodeInput[] };
  /** #117: lets a test drive the tenant_refused branch without naming Microsoft. */
  isTenantRefusal?: (failure: AuthorizationCallbackError) => boolean;
}

function fakeAdapter({
  exchange,
  seen,
  isTenantRefusal,
}: FakeAdapterOptions = {}): ProviderAdapter {
  return {
    connection: {
      imap: { host: "imap.fake.test", port: 993, security: "tls" },
      smtp: { host: "smtp.fake.test", port: 587, security: "starttls" },
    },
    scopes: ["https://mail.google.com/", "email"],
    authorizationUrl(input) {
      seen?.authorization.push(input);
      const url = new URL("https://provider.test/authorize");
      url.searchParams.set("client_id", input.clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("scope", this.scopes.join(" "));
      url.searchParams.set("state", input.state);
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("prompt", "select_account");
      if (input.loginHint) {
        url.searchParams.set("login_hint", input.loginHint);
      }
      return url.toString();
    },
    async exchangeCode(input) {
      seen?.exchange.push(input);
      return exchange ? exchange(input) : fakeGrant();
    },
    async refresh() {
      return { ok: false, reason: "transient", detail: "not exercised here" };
    },
    ...(isTenantRefusal ? { isTenantRefusal } : {}),
  };
}

interface TestAppOptions {
  adapter?: ProviderAdapter | null;
  verify?: typeof verifyMailAccountCredentials;
  syncManager?: SyncManager;
}

function buildTestApp({ adapter = fakeAdapter(), verify, syncManager }: TestAppOptions = {}) {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    // `null` is "this build has no adapter for Google" — the shape Microsoft
    // is in until #117, expressed against the Provider the tests can drive.
    providerAdapters: adapter ? { google: adapter } : {},
    mailAccountVerify: verify ?? (async () => ({ ok: true })),
    syncManager,
  });
}

async function createUserWithCookie(): Promise<{ userId: string; cookie: string }> {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    username: `user-${userId}`,
    passwordHash: "not-a-real-hash",
    role: "member",
  });
  const { token } = await createSession(db, userId);
  return { userId, cookie: `mail_session=${token}` };
}

async function registerGoogle(): Promise<void> {
  await upsertProviderRegistration(
    db,
    "google",
    "client-id-123",
    sealSecret("client-secret", "google", deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY)),
  );
}

/** The `state` a start call handed out — read back off the one authorization URL the fake was asked to build. */
function stateFrom(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("expected the authorization URL to carry a state parameter");
  return state;
}

/** The outcome code the callback redirected with — the only thing the Client ever learns from it. */
function outcomeOf(location: string): string | null {
  return new URL(location).searchParams.get(OAUTH_SIGN_IN_OUTCOME_PARAM);
}

function expectRateLimited(
  response: Awaited<ReturnType<ReturnType<typeof buildTestApp>["inject"]>>,
) {
  expect(response.statusCode).toBe(429);
  expect(response.json()).toMatchObject({ error: "rate_limited" });
  expect(response.headers["retry-after"]).toBeDefined();
}

describe("GET /auth/oauth/providers", () => {
  it("401s unauthenticated — availability is a signed-in User's question", async () => {
    const app = buildTestApp();
    expect((await app.inject({ method: "GET", url: "/auth/oauth/providers" })).statusCode).toBe(
      401,
    );
  });

  it("reports an unregistered Provider as unavailable rather than hiding it", async () => {
    const app = buildTestApp();
    const { cookie } = await createUserWithCookie();

    const response = await app.inject({
      method: "GET",
      url: "/auth/oauth/providers",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().providers).toEqual([
      { provider: "google", available: false, unavailableReason: "not_registered" },
      // Microsoft has no adapter in this build (#117) — unavailable for a
      // reason registering something wouldn't fix.
      { provider: "microsoft", available: false, unavailableReason: "not_supported" },
    ]);
  });

  it("reports a registered Provider with an adapter as available", async () => {
    const app = buildTestApp();
    const { cookie } = await createUserWithCookie();
    await registerGoogle();

    const response = await app.inject({
      method: "GET",
      url: "/auth/oauth/providers",
      headers: { cookie },
    });

    expect(response.json().providers[0]).toEqual({
      provider: "google",
      available: true,
      unavailableReason: null,
    });
  });

  it("keeps a Provider unavailable when it is registered but this build has no adapter", async () => {
    const app = buildTestApp({ adapter: null });
    const { cookie } = await createUserWithCookie();
    await registerGoogle();

    const response = await app.inject({
      method: "GET",
      url: "/auth/oauth/providers",
      headers: { cookie },
    });

    expect(response.json().providers[0]).toMatchObject({
      available: false,
      unavailableReason: "not_supported",
    });
  });
});

describe("POST /auth/oauth/:provider/start", () => {
  it("401s unauthenticated", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "POST", url: "/auth/oauth/google/start" });
    expect(response.statusCode).toBe(401);
  });

  it("400s an unknown Provider name", async () => {
    const app = buildTestApp();
    const { cookie } = await createUserWithCookie();
    const response = await app.inject({
      method: "POST",
      url: "/auth/oauth/yahoo/start",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it("409s when the Provider is not registered on this instance", async () => {
    const app = buildTestApp();
    const { cookie } = await createUserWithCookie();

    const response = await app.inject({
      method: "POST",
      url: "/auth/oauth/google/start",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "provider_not_registered" });
  });

  it("409s when the Provider has no adapter in this build", async () => {
    const app = buildTestApp({ adapter: null });
    const { cookie } = await createUserWithCookie();
    await registerGoogle();

    const response = await app.inject({
      method: "POST",
      url: "/auth/oauth/google/start",
      headers: { cookie },
    });

    expect(response.json()).toEqual({ error: "provider_not_supported" });
  });

  it("records a sign-in attempt and answers with the Provider's authorization URL", async () => {
    const seen = {
      authorization: [] as AuthorizationUrlInput[],
      exchange: [] as ExchangeCodeInput[],
    };
    const app = buildTestApp({ adapter: fakeAdapter({ seen }) });
    const { userId, cookie } = await createUserWithCookie();
    await registerGoogle();

    const response = await app.inject({
      method: "POST",
      url: "/auth/oauth/google/start",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const url = new URL(response.json().authorizationUrl);
    expect(url.searchParams.get("scope")).toBe("https://mail.google.com/ email");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    // The registered client ID and #115's exact redirect URI, not something
    // this route invented.
    expect(seen.authorization[0]).toMatchObject({
      clientId: "client-id-123",
      redirectUri: GOOGLE_REDIRECT_URI,
    });

    const [attempt] = await db
      .select()
      .from(oauthSignInAttempts)
      .where(eq(oauthSignInAttempts.userId, userId));
    expect(attempt).toMatchObject({ provider: "google", purpose: "add_mail_account" });
    // The state travels in the URL; only its hash is stored (`sessions`'
    // own convention), and the PKCE challenge is the verifier's S256.
    expect(attempt?.id).not.toBe(url.searchParams.get("state"));
    expect(deriveCodeChallenge(attempt?.codeVerifier ?? "")).toBe(
      url.searchParams.get("code_challenge"),
    );
  });

  it("404s a mailAccountId this User doesn't own", async () => {
    const app = buildTestApp();
    const { cookie } = await createUserWithCookie();
    await registerGoogle();
    const otherAccount = await createTestMailAccount(db, { emailAddress: "other@gmail.com" });

    const response = await app.inject({
      method: "POST",
      url: "/auth/oauth/google/start",
      headers: { cookie },
      payload: { mailAccountId: otherAccount.id },
    });

    expect(response.statusCode).toBe(404);
  });

  it("naming a mailAccountId (#119) starts a reauth attempt with login_hint set to that account's own address", async () => {
    const seen = {
      authorization: [] as AuthorizationUrlInput[],
      exchange: [] as ExchangeCodeInput[],
    };
    const app = buildTestApp({ adapter: fakeAdapter({ seen }) });
    const { userId, cookie } = await createUserWithCookie();
    await registerGoogle();
    const account = await createTestMailAccount(db, {
      userId,
      emailAddress: "existing@gmail.com",
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/oauth/google/start",
      headers: { cookie },
      payload: { mailAccountId: account.id },
    });

    expect(response.statusCode).toBe(200);
    const url = new URL(response.json().authorizationUrl);
    // The Client never supplies this — it comes from the stored row, so a
    // tampered request can't point the hint at a different identity.
    expect(url.searchParams.get("login_hint")).toBe("existing@gmail.com");
    expect(seen.authorization[0]).toMatchObject({ loginHint: "existing@gmail.com" });

    const [attempt] = await db
      .select()
      .from(oauthSignInAttempts)
      .where(eq(oauthSignInAttempts.userId, userId));
    expect(attempt).toMatchObject({ purpose: "reauth", mailAccountId: account.id });
  });

  it("rate-limits repeated start attempts by the same User", async () => {
    const app = buildTestApp();
    const { cookie } = await createUserWithCookie();
    await registerGoogle();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/auth/oauth/google/start",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(200);
    }

    expectRateLimited(
      await app.inject({
        method: "POST",
        url: "/auth/oauth/google/start",
        headers: { cookie },
      }),
    );
  });
});

describe("GET /auth/oauth/:provider/callback", () => {
  /** Runs a start call and hands back everything a callback needs to be built by hand. */
  async function start(app: ReturnType<typeof buildTestApp>, cookie: string) {
    const response = await app.inject({
      method: "POST",
      url: "/auth/oauth/google/start",
      headers: { cookie },
    });
    return stateFrom(response.json().authorizationUrl);
  }

  function callbackUrl(params: Record<string, string>): string {
    return `/auth/oauth/google/callback?${new URLSearchParams(params).toString()}`;
  }

  it("creates a Mail Account with an oauth credential at the Provider's address and redirects with signed_in", async () => {
    const seen = {
      authorization: [] as AuthorizationUrlInput[],
      exchange: [] as ExchangeCodeInput[],
    };
    const startSync = vi.fn();
    const syncManager: SyncManager = {
      start: startSync,
      restart: async () => {},
      stopAll: async () => {},
    };
    const app = buildTestApp({ adapter: fakeAdapter({ seen }), syncManager });
    const { userId, cookie } = await createUserWithCookie();
    await registerGoogle();
    const state = await start(app, cookie);

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "auth-code", state }),
      headers: { cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(outcomeOf(response.headers.location as string)).toBe("signed_in");

    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.userId, userId));
    expect(row).toMatchObject({
      // Never typed by the User — this is the fake's identity answer.
      emailAddress: "someone@gmail.com",
      username: "someone@gmail.com",
      imapHost: "imap.fake.test",
      smtpHost: "smtp.fake.test",
      status: "active",
    });
    expect(row?.credential).toMatchObject({ kind: "oauth", provider: "google" });
    // The stored Grant is sealed, never the raw token (ADR-0003).
    expect(JSON.stringify(row?.credential)).not.toContain("access-token");
    // The code exchange used the verifier held server-side, not anything
    // that came back through the browser.
    expect(seen.exchange[0]).toMatchObject({
      code: "auth-code",
      clientId: "client-id-123",
      clientSecret: "client-secret",
      redirectUri: GOOGLE_REDIRECT_URI,
    });
    expect(startSync).toHaveBeenCalledTimes(1);
  });

  it("consumes the attempt, so a replayed callback creates nothing and reports invalid_state", async () => {
    const app = buildTestApp();
    const { userId, cookie } = await createUserWithCookie();
    await registerGoogle();
    const state = await start(app, cookie);

    await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state }),
      headers: { cookie },
    });
    const replay = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state }),
      headers: { cookie },
    });

    expect(outcomeOf(replay.headers.location as string)).toBe("invalid_state");
    expect(
      await db.select().from(mailAccounts).where(eq(mailAccounts.userId, userId)),
    ).toHaveLength(1);
  });

  it("rejects a state that was never issued", async () => {
    const app = buildTestApp();
    const { userId, cookie } = await createUserWithCookie();
    await registerGoogle();

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state: "not-a-real-state" }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("invalid_state");
    expect(
      await db.select().from(mailAccounts).where(eq(mailAccounts.userId, userId)),
    ).toHaveLength(0);
  });

  it("rejects another User's state — the session cookie, not the state, says whose account this is", async () => {
    const app = buildTestApp();
    const starter = await createUserWithCookie();
    const other = await createUserWithCookie();
    await registerGoogle();
    const state = await start(app, starter.cookie);

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state }),
      headers: { cookie: other.cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("invalid_state");
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
  });

  it("reports session_expired when the session cookie is gone by the time the Provider redirects back", async () => {
    const app = buildTestApp();
    const { cookie } = await createUserWithCookie();
    await registerGoogle();
    const state = await start(app, cookie);

    const response = await app.inject({ method: "GET", url: callbackUrl({ code: "c", state }) });

    expect(outcomeOf(response.headers.location as string)).toBe("session_expired");
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
  });

  it("reports cancelled when the User declines at the consent screen", async () => {
    const app = buildTestApp();
    const { cookie } = await createUserWithCookie();
    await registerGoogle();
    const state = await start(app, cookie);

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ error: "access_denied", state }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("cancelled");
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
  });

  it("reports provider_error when the token exchange fails", async () => {
    const app = buildTestApp({
      adapter: fakeAdapter({
        exchange: async () => {
          throw new Error("invalid_client");
        },
      }),
    });
    const { cookie } = await createUserWithCookie();
    await registerGoogle();
    const state = await start(app, cookie);

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("provider_error");
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
  });

  it("reports tenant_refused when the authorize redirect carries an error the adapter classifies as one (#117)", async () => {
    const app = buildTestApp({
      adapter: fakeAdapter({ isTenantRefusal: ({ error }) => error === "consent_required" }),
    });
    const { cookie } = await createUserWithCookie();
    await registerGoogle();
    const state = await start(app, cookie);

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ error: "consent_required", state }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("tenant_refused");
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
  });

  it("keeps an unclassified authorize error as provider_error even with a tenant-aware adapter", async () => {
    const app = buildTestApp({
      adapter: fakeAdapter({ isTenantRefusal: ({ error }) => error === "consent_required" }),
    });
    const { cookie } = await createUserWithCookie();
    await registerGoogle();
    const state = await start(app, cookie);

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ error: "server_error", state }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("provider_error");
  });

  it("reports tenant_refused when the token exchange throws an error the adapter classifies as one (#117)", async () => {
    const app = buildTestApp({
      adapter: fakeAdapter({
        isTenantRefusal: ({ error }) => error === "unauthorized_client",
        exchange: async () => {
          throw Object.assign(new Error("Microsoft token endpoint: unauthorized_client"), {
            error: "unauthorized_client",
          });
        },
      }),
    });
    const { cookie } = await createUserWithCookie();
    await registerGoogle();
    const state = await start(app, cookie);

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("tenant_refused");
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
  });

  it("refuses an address already among this User's Mail Accounts", async () => {
    const app = buildTestApp();
    const { userId, cookie } = await createUserWithCookie();
    await registerGoogle();

    const first = await start(app, cookie);
    await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state: first }),
      headers: { cookie },
    });
    const second = await start(app, cookie);
    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state: second }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("duplicate_address");
    expect(
      await db.select().from(mailAccounts).where(eq(mailAccounts.userId, userId)),
    ).toHaveLength(1);
  });

  it("lets a second User sign in as the same address — ownership is per User (ADR-0004)", async () => {
    const app = buildTestApp();
    const first = await createUserWithCookie();
    const second = await createUserWithCookie();
    await registerGoogle();

    for (const { cookie } of [first, second]) {
      const state = await start(app, cookie);
      await app.inject({
        method: "GET",
        url: callbackUrl({ code: "c", state }),
        headers: { cookie },
      });
    }

    expect(await db.select().from(mailAccounts)).toHaveLength(2);
  });

  it("verifies over XOAUTH2 before writing the row, and writes nothing when verification fails", async () => {
    const verify = vi.fn(async () => ({
      ok: false as const,
      reason: "credentials_rejected" as const,
      detail: "XOAUTH2 rejected",
    }));
    const app = buildTestApp({ verify });
    const { cookie } = await createUserWithCookie();
    await registerGoogle();
    const state = await start(app, cookie);

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("verification_failed");
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "someone@gmail.com",
        credential: { kind: "oauth", accessToken: "access-token" },
      }),
    );
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
  });

  it("reports provider_not_registered when the Owner removed the Registration mid-sign-in", async () => {
    const app = buildTestApp();
    const { cookie } = await createUserWithCookie();
    await registerGoogle();
    const state = await start(app, cookie);
    await deleteProviderRegistration(db, "google");

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("provider_not_registered");
    expect(await db.select().from(mailAccounts)).toHaveLength(0);
  });

  it("rate-limits repeated callback attempts by the same User", async () => {
    const app = buildTestApp();
    const { userId, cookie } = await createUserWithCookie();
    await registerGoogle();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const state = (
        await startSignInAttempt(db, {
          userId,
          provider: "google",
          purpose: "add_mail_account",
        })
      ).state;
      expect(
        (
          await app.inject({
            method: "GET",
            url: callbackUrl({ code: `code-${attempt}`, state }),
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(302);
    }

    const state = (
      await startSignInAttempt(db, {
        userId,
        provider: "google",
        purpose: "add_mail_account",
      })
    ).state;
    expectRateLimited(
      await app.inject({
        method: "GET",
        url: callbackUrl({ code: "too-many", state }),
        headers: { cookie },
      }),
    );
  });
});

describe("GET /auth/oauth/:provider/callback (reauth, #119)", () => {
  function callbackUrl(params: Record<string, string>): string {
    return `/auth/oauth/google/callback?${new URLSearchParams(params).toString()}`;
  }

  /** Starts a `reauth` attempt for the given Mail Account and hands back the state to build a callback with. */
  async function startReauth(
    app: ReturnType<typeof buildTestApp>,
    cookie: string,
    mailAccountId: string,
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/auth/oauth/google/start",
      headers: { cookie },
      payload: { mailAccountId },
    });
    return stateFrom(response.json().authorizationUrl);
  }

  it("replaces the credential on the same Mail Account id when the address matches, sets active, restarts sync, and reports reauth_succeeded", async () => {
    const restart = vi.fn(async () => {});
    const syncManager: SyncManager = { start: vi.fn(), restart, stopAll: async () => {} };
    const app = buildTestApp({
      adapter: fakeAdapter({ exchange: async () => fakeGrant({ emailAddress: "vic@gmail.com" }) }),
      syncManager,
    });
    const { userId, cookie } = await createUserWithCookie();
    await registerGoogle();
    const account = await createTestMailAccount(db, { userId, emailAddress: "vic@gmail.com" });
    const state = await startReauth(app, cookie, account.id);

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("reauth_succeeded");

    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    // Same id, same row — never a new Mail Account.
    expect(row?.id).toBe(account.id);
    expect(row?.status).toBe("active");
    expect(row?.credential).toMatchObject({ kind: "oauth", provider: "google" });
    expect(restart).toHaveBeenCalledWith(account.id);
    expect(await db.select().from(mailAccounts)).toHaveLength(1);
  });

  it("switches a password Mail Account to a Grant on the same id, keeping it the only row", async () => {
    const restart = vi.fn(async () => {});
    const app = buildTestApp({
      adapter: fakeAdapter({ exchange: async () => fakeGrant({ emailAddress: "vic@gmail.com" }) }),
      syncManager: { start: vi.fn(), restart, stopAll: async () => {} },
    });
    const { userId, cookie } = await createUserWithCookie();
    await registerGoogle();
    // A password account — #114's default, no `oauth` option.
    const account = await createTestMailAccount(db, { userId, emailAddress: "vic@gmail.com" });
    expect(account.credential).toMatchObject({ kind: "password" });
    const state = await startReauth(app, cookie, account.id);

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("reauth_succeeded");
    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(row?.credential).toMatchObject({ kind: "oauth" });
  });

  it("refuses a mismatched address, changing nothing, and reports reauth_address_mismatch", async () => {
    const restart = vi.fn(async () => {});
    const app = buildTestApp({
      adapter: fakeAdapter({
        exchange: async () => fakeGrant({ emailAddress: "someone-else@gmail.com" }),
      }),
      syncManager: { start: vi.fn(), restart, stopAll: async () => {} },
    });
    const { userId, cookie } = await createUserWithCookie();
    await registerGoogle();
    const account = await createTestMailAccount(db, { userId, emailAddress: "vic@gmail.com" });
    const state = await startReauth(app, cookie, account.id);

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("reauth_address_mismatch");
    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(row?.credential).toMatchObject({ kind: "password" });
    expect(row?.status).toBe("active");
    expect(restart).not.toHaveBeenCalled();
  });

  it("verifies over XOAUTH2 before replacing the credential, and changes nothing when verification fails", async () => {
    const verify = vi.fn(async () => ({
      ok: false as const,
      reason: "credentials_rejected" as const,
      detail: "XOAUTH2 rejected",
    }));
    const app = buildTestApp({
      adapter: fakeAdapter({ exchange: async () => fakeGrant({ emailAddress: "vic@gmail.com" }) }),
      verify,
    });
    const { userId, cookie } = await createUserWithCookie();
    await registerGoogle();
    const account = await createTestMailAccount(db, { userId, emailAddress: "vic@gmail.com" });
    const state = await startReauth(app, cookie, account.id);

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("verification_failed");
    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(row?.credential).toMatchObject({ kind: "password" });
  });

  it("reports invalid_state when the Mail Account was deleted between starting and the callback", async () => {
    const app = buildTestApp({
      adapter: fakeAdapter({ exchange: async () => fakeGrant({ emailAddress: "vic@gmail.com" }) }),
    });
    const { userId, cookie } = await createUserWithCookie();
    await registerGoogle();
    const account = await createTestMailAccount(db, { userId, emailAddress: "vic@gmail.com" });
    const state = await startReauth(app, cookie, account.id);
    await db.delete(mailAccounts).where(eq(mailAccounts.id, account.id));

    const response = await app.inject({
      method: "GET",
      url: callbackUrl({ code: "c", state }),
      headers: { cookie },
    });

    expect(outcomeOf(response.headers.location as string)).toBe("invalid_state");
  });
});

describe("defaultProviderAdapters", () => {
  it("wires in both Google (#116) and Microsoft (#117), the only two Providers", () => {
    expect(Object.keys(defaultProviderAdapters).sort()).toEqual(["google", "microsoft"]);
  });
});
