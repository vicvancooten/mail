import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { notifierOutbox } from "../db/schema.js";
import {
  getProviderRegistration,
  upsertProviderRegistration,
} from "../provider-registrations/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { deriveCredentialKey, sealSecret } from "./credential-crypto.js";
import { needsGrantRefresh, refreshMailAccountGrant } from "./grant-refresh.js";
import type { ProviderAdapter, ProviderRefreshResult } from "./provider-adapter.js";
import { getMailAccountById } from "./store.js";

/**
 * `refreshMailAccountGrant` (#118, ADR-0021), driven through an injected
 * fake `ProviderAdapter` — the acceptance criteria's own words: "near-expiry
 * triggers a refresh and the new tokens are sealed onto the Mail Account; a
 * withdrawn result produces exactly one Needs Reauth transition and one
 * notification record; a transient error leaves the account active and
 * writes a failing outcome on the Registration."
 */

let db: Db;
let closeDb: () => Promise<void>;
const credentialKey = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

function fakeAdapter(refresh: () => Promise<ProviderRefreshResult>): ProviderAdapter {
  return {
    connection: {
      imap: { host: "imap.fake.test", port: 993, security: "tls" },
      smtp: { host: "smtp.fake.test", port: 587, security: "starttls" },
    },
    scopes: ["https://mail.google.com/"],
    authorizationUrl: () => "https://provider.test/authorize",
    exchangeCode: () => {
      throw new Error("not exercised here");
    },
    refresh,
  };
}

async function registerGoogle(): Promise<void> {
  await upsertProviderRegistration(
    db,
    "google",
    "client-id",
    sealSecret("client-secret", "google", credentialKey),
  );
}

describe("needsGrantRefresh", () => {
  it("is false for a password credential", () => {
    expect(
      needsGrantRefresh(
        { kind: "password", secret: { keyVersion: 1, iv: "", ciphertext: "", authTag: "" } },
        new Date(),
      ),
    ).toBe(false);
  });

  it("is true once inside the safety margin, false well before it", () => {
    const credential = {
      kind: "oauth" as const,
      provider: "google" as const,
      accessToken: { keyVersion: 1, iv: "", ciphertext: "", authTag: "" },
      refreshToken: { keyVersion: 1, iv: "", ciphertext: "", authTag: "" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scope: [],
    };
    expect(needsGrantRefresh(credential, new Date(), 10 * 60_000)).toBe(true);
    expect(needsGrantRefresh(credential, new Date(), 30_000)).toBe(false);
  });
});

describe("refreshMailAccountGrant", () => {
  it("skips a password-credentialed Mail Account", async () => {
    const account = await createTestMailAccount(db, { password: "swordfish" });
    const outcome = await refreshMailAccountGrant(db, account, {
      credentialKey,
      adapters: { google: fakeAdapter(() => Promise.reject(new Error("never called"))) },
    });
    expect(outcome).toEqual({ result: "skipped", reason: "not an oauth credential" });
  });

  it("skips when there's no Provider Registration for the account's provider", async () => {
    const account = await createTestMailAccount(db, { oauth: { accessToken: "at" } });
    const outcome = await refreshMailAccountGrant(db, account, {
      credentialKey,
      adapters: { google: fakeAdapter(() => Promise.reject(new Error("never called"))) },
    });
    expect(outcome).toMatchObject({ result: "skipped" });
  });

  it("reseals the new tokens onto the Mail Account and records a working outcome", async () => {
    await registerGoogle();
    const account = await createTestMailAccount(db, { oauth: { accessToken: "old-access-token" } });

    const outcome = await refreshMailAccountGrant(db, account, {
      credentialKey,
      adapters: {
        google: fakeAdapter(() =>
          Promise.resolve({
            ok: true,
            accessToken: "new-access-token",
            refreshToken: "new-refresh-token",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            scope: ["https://mail.google.com/"],
          }),
        ),
      },
    });

    expect(outcome).toEqual({ result: "refreshed" });

    const stored = await getMailAccountById(db, account.id);
    expect(stored?.status).toBe("active");
    expect(stored?.credential).toMatchObject({ kind: "oauth", provider: "google" });

    const registration = await getProviderRegistration(db, "google");
    expect(registration?.lastRefreshError).toBeNull();
    expect(registration?.lastRefreshAt).not.toBeNull();
  });

  it("parks the Mail Account in Needs Reauth on a withdrawn refresh, notifying exactly once", async () => {
    await registerGoogle();
    const account = await createTestMailAccount(db, {
      oauth: { accessToken: "a-withdrawn-grant" },
    });

    const outcome = await refreshMailAccountGrant(db, account, {
      credentialKey,
      adapters: {
        google: fakeAdapter(() =>
          Promise.resolve({ ok: false, reason: "withdrawn", detail: "invalid_grant" }),
        ),
      },
    });
    expect(outcome).toEqual({ result: "withdrawn", detail: "invalid_grant" });

    const stored = await getMailAccountById(db, account.id);
    expect(stored?.status).toBe("needs_reauth");

    const notifications = await db
      .select()
      .from(notifierOutbox)
      .where(eq(notifierOutbox.mailAccountId, account.id));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.kind).toBe("needs_reauth");

    // A withdrawn refresh is a Mail Account fact, not a Provider one — the
    // Registration's own refresh outcome stays untouched.
    const registration = await getProviderRegistration(db, "google");
    expect(registration?.lastRefreshAt).toBeNull();
  });

  it("a second withdrawn refresh for an account already in Needs Reauth records nothing new", async () => {
    await registerGoogle();
    const account = await createTestMailAccount(db, {
      oauth: { accessToken: "a-withdrawn-grant" },
    });
    const adapter = fakeAdapter(() =>
      Promise.resolve({ ok: false, reason: "withdrawn", detail: "invalid_grant" }),
    );

    await refreshMailAccountGrant(db, account, { credentialKey, adapters: { google: adapter } });
    const stillParked = await getMailAccountById(db, account.id);
    if (!stillParked) throw new Error("account vanished");

    const second = await refreshMailAccountGrant(db, stillParked, {
      credentialKey,
      adapters: { google: adapter },
    });
    expect(second).toEqual({ result: "withdrawn", detail: "invalid_grant" });

    const notifications = await db
      .select()
      .from(notifierOutbox)
      .where(eq(notifierOutbox.mailAccountId, account.id));
    expect(notifications).toHaveLength(1);
  });

  it("leaves the Mail Account active and records a failing outcome on a transient error", async () => {
    await registerGoogle();
    const account = await createTestMailAccount(db, { oauth: { accessToken: "at" } });

    const outcome = await refreshMailAccountGrant(db, account, {
      credentialKey,
      adapters: {
        google: fakeAdapter(() =>
          Promise.resolve({ ok: false, reason: "transient", detail: "network blip" }),
        ),
      },
    });
    expect(outcome).toEqual({ result: "transient", detail: "network blip" });

    const stored = await getMailAccountById(db, account.id);
    expect(stored?.status).toBe("active");

    const registration = await getProviderRegistration(db, "google");
    expect(registration?.lastRefreshError).toBe("network blip");
    expect(registration?.lastRefreshAt).not.toBeNull();
  });

  it("a later success clears a prior failing outcome on the Registration", async () => {
    await registerGoogle();
    const account = await createTestMailAccount(db, { oauth: { accessToken: "at" } });

    await refreshMailAccountGrant(db, account, {
      credentialKey,
      adapters: {
        google: fakeAdapter(() =>
          Promise.resolve({ ok: false, reason: "transient", detail: "network blip" }),
        ),
      },
    });
    expect((await getProviderRegistration(db, "google"))?.lastRefreshError).toBe("network blip");

    const refreshed = await getMailAccountById(db, account.id);
    if (!refreshed) throw new Error("account vanished");
    await refreshMailAccountGrant(db, refreshed, {
      credentialKey,
      adapters: {
        google: fakeAdapter(() =>
          Promise.resolve({
            ok: true,
            accessToken: "new-access-token",
            refreshToken: "new-refresh-token",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            scope: ["https://mail.google.com/"],
          }),
        ),
      },
    });
    expect((await getProviderRegistration(db, "google"))?.lastRefreshError).toBeNull();
  });
});
