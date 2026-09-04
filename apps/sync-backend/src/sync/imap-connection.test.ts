import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import { getMailAccountById } from "../mail-accounts/store.js";
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
