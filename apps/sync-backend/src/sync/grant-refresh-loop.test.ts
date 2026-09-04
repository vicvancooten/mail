import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import { deriveCredentialKey, sealSecret } from "../mail-accounts/credential-crypto.js";
import type { ProviderAdapter } from "../mail-accounts/provider-adapter.js";
import { getMailAccountById } from "../mail-accounts/store.js";
import {
  getProviderRegistration,
  upsertProviderRegistration,
} from "../provider-registrations/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { startGrantRefreshLoop } from "./grant-refresh-loop.js";

/**
 * `startGrantRefreshLoop` (#118): the scheduler around `refreshMailAccountGrant`
 * — proving it picks up an account near expiry on its immediate first tick,
 * leaves one with nothing to refresh against alone, and stops cleanly. Same
 * shape `search-index-loop.ts`/`snooze-wake-loop.ts` already prove for their
 * own sweeps. `refreshMailAccountGrant`'s own branches (withdrawn/transient/
 * success) are `mail-accounts/grant-refresh.test.ts`'s job, not re-proven
 * here.
 */

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

function fakeAdapter(refresh: ProviderAdapter["refresh"]): ProviderAdapter {
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

describe("startGrantRefreshLoop", () => {
  it("refreshes a near-expiry account on its first (immediate) tick", async () => {
    const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
    await upsertProviderRegistration(
      db,
      "google",
      "client-id",
      sealSecret("secret", "google", key),
    );
    const account = await createTestMailAccount(db, { oauth: { accessToken: "old-token" } });

    let refreshCalls = 0;
    const handle = startGrantRefreshLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      providerAdapters: {
        google: fakeAdapter(() => {
          refreshCalls += 1;
          return Promise.resolve({
            ok: true,
            accessToken: "new-access-token",
            refreshToken: "new-refresh-token",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            scope: ["https://mail.google.com/"],
          });
        }),
      },
      intervalMs: 60_000,
      // The test double account's `expiresAt` is an hour out — a full day's
      // margin makes it "near expiry" without the test caring about the
      // exact value `createTestMailAccount` seeds.
      safetyMarginMs: 24 * 60 * 60_000,
    });

    await vi.waitFor(async () => {
      expect(refreshCalls).toBe(1);
    });
    await handle.stop();

    const stored = await getMailAccountById(db, account.id);
    expect(stored?.credential).toMatchObject({ kind: "oauth" });
    const registration = await getProviderRegistration(db, "google");
    expect(registration?.lastRefreshError).toBeNull();
    expect(registration?.lastRefreshAt).not.toBeNull();
  });

  it("skips an account with no Provider Registration, never calling the adapter", async () => {
    await createTestMailAccount(db, { oauth: { accessToken: "old-token" } });

    let called = false;
    const handle = startGrantRefreshLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      providerAdapters: {
        google: fakeAdapter(() => {
          called = true;
          return Promise.resolve({ ok: false, reason: "transient", detail: "unexpected" });
        }),
      },
      intervalMs: 60_000,
      safetyMarginMs: 24 * 60 * 60_000,
    });
    await handle.stop();

    expect(called).toBe(false);
  });

  it("stops cleanly, idempotently, without a hang or a throw", async () => {
    const handle = startGrantRefreshLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      providerAdapters: {},
      intervalMs: 60_000,
    });
    await expect(handle.stop()).resolves.toBeUndefined();
    await expect(handle.stop()).resolves.toBeUndefined();
  });
});
