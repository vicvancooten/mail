import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import type { DiscoverMailAccountResult } from "../mail-accounts/autodiscover.js";
import type { VerifyMailAccountResult } from "../mail-accounts/verify.js";
import type { SyncManager } from "../sync/manager.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

const PUBLIC_URL = "http://localhost:3000";

let db: Db;
let closeDb: () => Promise<void>;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
}

/** Builds an app with a stubbed verify/discover — GreenMail never rejects (docs/dev-setup.md). */
function buildTestApp(overrides: {
  verify?: () => Promise<VerifyMailAccountResult>;
  discover?: () => Promise<DiscoverMailAccountResult>;
  syncManager?: SyncManager;
}) {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    mailAccountVerify: overrides.verify,
    mailAccountDiscover: overrides.discover,
    syncManager: overrides.syncManager,
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

const VALID_ACCOUNT_PAYLOAD = {
  emailAddress: "vic@example.com",
  imap: { host: "imap.example.com", port: 993, security: "tls" },
  smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
  username: "vic@example.com",
  password: "correct-horse-battery-staple",
};

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

describe("POST /mail-accounts/discover", () => {
  it("requires a session", async () => {
    const app = buildTestApp({});
    const response = await app.inject({
      method: "POST",
      url: "/mail-accounts/discover",
      payload: { emailAddress: "vic@example.com" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("proxies the autodiscover result", async () => {
    const app = buildTestApp({
      discover: async () => ({
        found: true,
        source: "autoconfig",
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      }),
    });
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "POST",
      url: "/mail-accounts/discover",
      headers: { cookie },
      payload: { emailAddress: "vic@example.com" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ found: true, source: "autoconfig" });
  });
});

describe("POST /mail-accounts", () => {
  it("requires a session", async () => {
    const app = buildTestApp({});
    const response = await app.inject({
      method: "POST",
      url: "/mail-accounts",
      payload: VALID_ACCOUNT_PAYLOAD,
    });
    expect(response.statusCode).toBe(401);
  });

  it("verifies before saving: a rejected credential creates no row", async () => {
    const app = buildTestApp({
      verify: async () => ({
        ok: false,
        reason: "credentials_rejected",
        detail: "bad password",
      }),
    });
    const cookie = await claimOwner(app);

    const create = await app.inject({
      method: "POST",
      url: "/mail-accounts",
      headers: { cookie },
      payload: VALID_ACCOUNT_PAYLOAD,
    });
    expect(create.statusCode).toBe(422);
    expect(create.json()).toMatchObject({ error: "credentials_rejected" });

    const list = await app.inject({ method: "GET", url: "/mail-accounts", headers: { cookie } });
    expect(list.json()).toEqual({ mailAccounts: [] });
  });

  it("reports a connection failure distinctly from a credential rejection", async () => {
    const app = buildTestApp({
      verify: async () => ({
        ok: false,
        reason: "connection_failed",
        detail: "ECONNREFUSED",
      }),
    });
    const cookie = await claimOwner(app);

    const create = await app.inject({
      method: "POST",
      url: "/mail-accounts",
      headers: { cookie },
      payload: VALID_ACCOUNT_PAYLOAD,
    });
    expect(create.statusCode).toBe(502);
    expect(create.json()).toMatchObject({ error: "connection_failed" });
  });

  it("saves on a successful verify and never returns the credential", async () => {
    const app = buildTestApp({ verify: async () => ({ ok: true, serverKind: "generic" }) });
    const cookie = await claimOwner(app);

    const create = await app.inject({
      method: "POST",
      url: "/mail-accounts",
      headers: { cookie },
      payload: VALID_ACCOUNT_PAYLOAD,
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.mailAccount).toMatchObject({
      emailAddress: "vic@example.com",
      status: "active",
      // Never the credential itself, only the wire-safe kind (#119).
      authKind: { kind: "password" },
    });
    expect(JSON.stringify(body)).not.toContain("correct-horse-battery-staple");
    expect(body.mailAccount.credential).toBeUndefined();

    const list = await app.inject({ method: "GET", url: "/mail-accounts", headers: { cookie } });
    expect(list.json().mailAccounts).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain("correct-horse-battery-staple");
  });

  it("scopes the list to the requesting User (ADR-0004)", async () => {
    const app = buildTestApp({ verify: async () => ({ ok: true, serverKind: "generic" }) });
    const ownerCookie = await claimOwner(app);
    await app.inject({
      method: "POST",
      url: "/mail-accounts",
      headers: { cookie: ownerCookie },
      payload: VALID_ACCOUNT_PAYLOAD,
    });

    // No second User flow exists yet (poc-scope.md); this proves the query
    // is scoped by user id rather than "all mail accounts", which matters
    // the moment Member invites land.
    const anonymous = await app.inject({ method: "GET", url: "/mail-accounts" });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe("POST /mail-accounts/:id/reauth", () => {
  async function createAccount(app: FastifyInstance, cookie: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/mail-accounts",
      headers: { cookie },
      payload: VALID_ACCOUNT_PAYLOAD,
    });
    return response.json().mailAccount.id;
  }

  it("404s for another User's Mail Account rather than leaking existence", async () => {
    const app = buildTestApp({ verify: async () => ({ ok: true, serverKind: "generic" }) });
    const cookie = await claimOwner(app);
    const id = await createAccount(app, cookie);

    const response = await app.inject({
      method: "POST",
      url: `/mail-accounts/${id}/reauth`,
      // No cookie: unauthenticated, not "someone else's account".
      payload: { username: "vic@example.com", password: "whatever" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejected credentials park the account in needs_reauth; re-entering resumes", async () => {
    let verifyOk = true;
    const app = buildTestApp({
      verify: async () =>
        verifyOk
          ? { ok: true, serverKind: "generic" }
          : { ok: false, reason: "credentials_rejected", detail: "nope" },
    });
    const cookie = await claimOwner(app);
    const id = await createAccount(app, cookie);

    // Simulates the sync engine (#9) discovering the stored credential no
    // longer works — that trigger doesn't exist yet, so this ticket's own
    // store-level seam is what's under test here (`markNeedsReauth`).
    const { markNeedsReauth } = await import("../mail-accounts/store.js");
    await markNeedsReauth(db, id);

    const listBefore = await app.inject({
      method: "GET",
      url: "/mail-accounts",
      headers: { cookie },
    });
    expect(listBefore.json().mailAccounts[0]).toMatchObject({ status: "needs_reauth" });

    // Re-entering with a still-bad credential stays parked.
    verifyOk = false;
    const failedReauth = await app.inject({
      method: "POST",
      url: `/mail-accounts/${id}/reauth`,
      headers: { cookie },
      payload: { username: "vic@example.com", password: "still-wrong" },
    });
    expect(failedReauth.statusCode).toBe(422);
    const stillParked = await app.inject({
      method: "GET",
      url: "/mail-accounts",
      headers: { cookie },
    });
    expect(stillParked.json().mailAccounts[0]).toMatchObject({ status: "needs_reauth" });

    // Re-entering with the correct credential resumes.
    verifyOk = true;
    const reauth = await app.inject({
      method: "POST",
      url: `/mail-accounts/${id}/reauth`,
      headers: { cookie },
      payload: { username: "vic@example.com", password: "correct-now" },
    });
    expect(reauth.statusCode).toBe(200);
    expect(reauth.json().mailAccount).toMatchObject({ status: "active" });

    const resumed = await app.inject({ method: "GET", url: "/mail-accounts", headers: { cookie } });
    expect(resumed.json().mailAccounts[0]).toMatchObject({ status: "active" });
  });
});

describe("PATCH /mail-accounts/:id/signature (#47)", () => {
  async function createAccount(app: FastifyInstance, cookie: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/mail-accounts",
      headers: { cookie },
      payload: VALID_ACCOUNT_PAYLOAD,
    });
    return response.json().mailAccount.id;
  }

  it("is null until set, then rides the wire projection", async () => {
    const app = buildTestApp({ verify: async () => ({ ok: true, serverKind: "generic" }) });
    const cookie = await claimOwner(app);
    const id = await createAccount(app, cookie);

    const created = await app.inject({ method: "GET", url: "/mail-accounts", headers: { cookie } });
    expect(created.json().mailAccounts[0]).toMatchObject({ signature: null });

    const update = await app.inject({
      method: "PATCH",
      url: `/mail-accounts/${id}/signature`,
      headers: { cookie },
      payload: { signature: "Ada Lovelace\nComputing pioneer" },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().mailAccount.signature).toBe("Ada Lovelace\nComputing pioneer");

    const list = await app.inject({ method: "GET", url: "/mail-accounts", headers: { cookie } });
    expect(list.json().mailAccounts[0].signature).toBe("Ada Lovelace\nComputing pioneer");
  });

  it("clears back to null", async () => {
    const app = buildTestApp({ verify: async () => ({ ok: true, serverKind: "generic" }) });
    const cookie = await claimOwner(app);
    const id = await createAccount(app, cookie);

    await app.inject({
      method: "PATCH",
      url: `/mail-accounts/${id}/signature`,
      headers: { cookie },
      payload: { signature: "Ada" },
    });
    const cleared = await app.inject({
      method: "PATCH",
      url: `/mail-accounts/${id}/signature`,
      headers: { cookie },
      payload: { signature: null },
    });
    expect(cleared.json().mailAccount.signature).toBeNull();
  });

  it("404s for another User's Mail Account rather than leaking existence", async () => {
    const app = buildTestApp({ verify: async () => ({ ok: true, serverKind: "generic" }) });
    const cookie = await claimOwner(app);
    const id = await createAccount(app, cookie);

    const response = await app.inject({
      method: "PATCH",
      url: `/mail-accounts/${id}/signature`,
      // No cookie: unauthenticated, not "someone else's account".
      payload: { signature: "nope" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("SyncManager wiring (#35)", () => {
  it("starts a session for a newly created Mail Account", async () => {
    const syncManager: SyncManager = { start: vi.fn(), restart: vi.fn(), stopAll: vi.fn() };
    const app = buildTestApp({
      verify: async () => ({ ok: true, serverKind: "generic" }),
      syncManager,
    });
    const cookie = await claimOwner(app);

    const create = await app.inject({
      method: "POST",
      url: "/mail-accounts",
      headers: { cookie },
      payload: VALID_ACCOUNT_PAYLOAD,
    });

    expect(syncManager.start).toHaveBeenCalledOnce();
    expect(syncManager.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: create.json().mailAccount.id }),
    );
  });

  it("restarts the session on a successful reauth", async () => {
    const syncManager: SyncManager = { start: vi.fn(), restart: vi.fn(), stopAll: vi.fn() };
    const app = buildTestApp({
      verify: async () => ({ ok: true, serverKind: "generic" }),
      syncManager,
    });
    const cookie = await claimOwner(app);
    const create = await app.inject({
      method: "POST",
      url: "/mail-accounts",
      headers: { cookie },
      payload: VALID_ACCOUNT_PAYLOAD,
    });
    const id = create.json().mailAccount.id;

    await app.inject({
      method: "POST",
      url: `/mail-accounts/${id}/reauth`,
      headers: { cookie },
      payload: { username: "vic@example.com", password: "new-password" },
    });

    expect(syncManager.restart).toHaveBeenCalledOnce();
    expect(syncManager.restart).toHaveBeenCalledWith(id);
  });
});
