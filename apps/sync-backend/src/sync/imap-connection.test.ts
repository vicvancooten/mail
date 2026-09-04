import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import { deriveCredentialKey, sealSecret } from "../mail-accounts/credential-crypto.js";
import type { ProviderAdapter } from "../mail-accounts/provider-adapter.js";
import { getMailAccountById } from "../mail-accounts/store.js";
import { upsertProviderRegistration } from "../provider-registrations/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";

/**
 * `connectMailAccount`'s auth branch and its Needs Reauth transition (#114),
 * against a fake `ImapFlow` rather than a real server: proving a rejected
 * *oauth* login parks the account exactly the way a rejected password does
 * needs to force a rejection on demand, and GreenMail
 * (`-Dgreenmail.auth.disabled`) accepts any credential, so it can't produce
 * one (see `oauth-credential.greenmail.test.ts` for the real-server, real-
 * success half of this AC).
 */
let capturedAuth: unknown;
let connectImpl: () => Promise<void>;

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(function (this: unknown, options: { auth: unknown }) {
    capturedAuth = options.auth;
    return {
      connect: () => connectImpl(),
      close: () => undefined,
      // No test here exercises Gmail detection (#121) — that's
      // `server-kind.test.ts` and the GreenMail suites — so an empty
      // capability list keeps `detectServerKind` callable without every
      // case here having to know about it.
      capabilities: new Map<string, boolean>(),
    };
  }),
}));

const { connectMailAccount, MailAccountNeedsReauthError } = await import("./imap-connection.js");

let db: Db;
let closeDb: () => Promise<void>;
const credentialKey = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);

function authFailure(): Error & { authenticationFailed: true } {
  return Object.assign(new Error("rejected"), { authenticationFailed: true as const });
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  connectImpl = async () => undefined;
});

afterAll(async () => {
  await closeDb?.();
});

describe("connectMailAccount", () => {
  it("authenticates a password account with user/pass", async () => {
    const account = await createTestMailAccount(db, { password: "swordfish" });
    await connectMailAccount(db, account, { credentialKey });
    expect(capturedAuth).toEqual({ user: account.username, pass: "swordfish" });
  });

  it("authenticates an oauth account with user/accessToken (XOAUTH2)", async () => {
    const account = await createTestMailAccount(db, { oauth: { accessToken: "the-access-token" } });
    await connectMailAccount(db, account, { credentialKey });
    expect(capturedAuth).toEqual({ user: account.username, accessToken: "the-access-token" });
  });

  it("parks a password account in Needs Reauth on a rejected login", async () => {
    connectImpl = async () => {
      throw authFailure();
    };
    const account = await createTestMailAccount(db, { password: "swordfish" });

    await expect(connectMailAccount(db, account, { credentialKey })).rejects.toThrow(
      MailAccountNeedsReauthError,
    );
    const stored = await getMailAccountById(db, account.id);
    expect(stored?.status).toBe("needs_reauth");
  });

  it("parks an oauth account in Needs Reauth on a rejected XOAUTH2 login, through the same transition", async () => {
    connectImpl = async () => {
      throw authFailure();
    };
    const account = await createTestMailAccount(db, {
      oauth: { accessToken: "a-withdrawn-token" },
    });

    await expect(connectMailAccount(db, account, { credentialKey })).rejects.toThrow(
      MailAccountNeedsReauthError,
    );
    const stored = await getMailAccountById(db, account.id);
    expect(stored?.status).toBe("needs_reauth");
  });
});

/**
 * #118's `grantRefresh` option — an oauth account's rejected token gets a
 * Provider round trip before Needs Reauth, and a near-expiry token gets one
 * before the connection attempt even starts. Everything above this describe
 * block passes no `grantRefresh` at all, so it keeps proving the pre-#118
 * fallback (a rejected oauth login lands straight in Needs Reauth) stays
 * intact for every caller that doesn't opt in.
 */
describe("connectMailAccount with grantRefresh", () => {
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

  async function registerGoogle(): Promise<void> {
    await upsertProviderRegistration(
      db,
      "google",
      "client-id",
      sealSecret("secret", "google", credentialKey),
    );
  }

  it("refreshes a near-expiry Grant before connecting, and authenticates with the fresh token", async () => {
    await registerGoogle();
    const account = await createTestMailAccount(db, {
      oauth: { accessToken: "soon-to-expire" },
    });
    // `createTestMailAccount` seeds an hour-out expiry; a day-long safety
    // margin makes it "near expiry" without depending on that exact value.
    const adapters = {
      google: fakeAdapter(() =>
        Promise.resolve({
          ok: true,
          accessToken: "fresh-access-token",
          refreshToken: "fresh-refresh-token",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          scope: ["https://mail.google.com/"],
        }),
      ),
    };

    await connectMailAccount(db, account, {
      credentialKey,
      grantRefresh: { adapters, safetyMarginMs: 24 * 60 * 60_000 },
    });

    expect(capturedAuth).toEqual({ user: account.username, accessToken: "fresh-access-token" });
  });

  it("refreshes once and retries on a rejected token, succeeding with the new one", async () => {
    await registerGoogle();
    const account = await createTestMailAccount(db, {
      oauth: { accessToken: "a-token-the-server-will-reject-once" },
    });

    let connectAttempts = 0;
    connectImpl = async () => {
      connectAttempts += 1;
      if (connectAttempts === 1) throw authFailure();
    };

    await connectMailAccount(db, account, {
      credentialKey,
      grantRefresh: {
        adapters: {
          google: fakeAdapter(() =>
            Promise.resolve({
              ok: true,
              accessToken: "fresh-access-token",
              refreshToken: "fresh-refresh-token",
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              scope: ["https://mail.google.com/"],
            }),
          ),
        },
      },
    });

    expect(connectAttempts).toBe(2);
    expect(capturedAuth).toEqual({ user: account.username, accessToken: "fresh-access-token" });
  });

  it("goes to Needs Reauth on a withdrawn refresh after a rejected token, not a plain retry error", async () => {
    await registerGoogle();
    const account = await createTestMailAccount(db, {
      oauth: { accessToken: "a-withdrawn-grant" },
    });
    connectImpl = async () => {
      throw authFailure();
    };

    await expect(
      connectMailAccount(db, account, {
        credentialKey,
        grantRefresh: {
          adapters: {
            google: fakeAdapter(() =>
              Promise.resolve({ ok: false, reason: "withdrawn", detail: "invalid_grant" }),
            ),
          },
        },
      }),
    ).rejects.toThrow(MailAccountNeedsReauthError);

    const stored = await getMailAccountById(db, account.id);
    expect(stored?.status).toBe("needs_reauth");
  });

  it("surfaces a transient refresh failure after a rejected token as a plain (non-Needs-Reauth) error", async () => {
    await registerGoogle();
    const account = await createTestMailAccount(db, { oauth: { accessToken: "at" } });
    connectImpl = async () => {
      throw authFailure();
    };

    let caught: unknown;
    try {
      await connectMailAccount(db, account, {
        credentialKey,
        grantRefresh: {
          adapters: {
            google: fakeAdapter(() =>
              Promise.resolve({ ok: false, reason: "transient", detail: "network blip" }),
            ),
          },
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(MailAccountNeedsReauthError);

    const stored = await getMailAccountById(db, account.id);
    expect(stored?.status).toBe("active");
  });
});
