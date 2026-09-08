import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { getMailAccountById } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { upgradeMailAccountsToConnectedAccounts } from "./boot-upgrade.js";
import {
  deriveCredentialKey,
  type SealedSecret,
  sealPasswordCredential,
  sealSecret,
  unsealPasswordCredential,
} from "./credential-crypto.js";
import { getConnectedAccountById } from "./store.js";

/** The pre-#199 `oauth` shape (ADR-0003) — one access token, not one per audience. */
interface LegacyOAuthCredential {
  kind: "oauth";
  provider: "google" | "microsoft";
  accessToken: SealedSecret;
  refreshToken: SealedSecret;
  expiresAt: string;
  scope: string[];
}

function sealLegacyOAuthCredential(
  tokens: {
    provider: "google" | "microsoft";
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scope: string[];
  },
  mailAccountId: string,
  key: Buffer,
): LegacyOAuthCredential {
  return {
    kind: "oauth",
    provider: tokens.provider,
    accessToken: sealSecret(tokens.accessToken, mailAccountId, key),
    refreshToken: sealSecret(tokens.refreshToken, mailAccountId, key),
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
  };
}

/**
 * The boot-time upgrade (#199, ADR-0022) driven directly, against a
 * hand-inserted **legacy** row — the pre-#199 shape (`credential`/`status`
 * physically on `mail_accounts`, the old single-audience `oauth` shape) that
 * only ever exists on a real pre-upgrade instance. This test puts
 * `mail_accounts` back into that physical shape first (idempotently — see
 * `resetToLegacyShape`), since the migration this ticket ships against a
 * *fresh* schema never leaves it there.
 */
let db: Db;
let closeDb: () => Promise<void>;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  await resetToLegacyShape(db);
});

afterAll(async () => {
  await closeDb?.();
});

/**
 * Puts `mail_accounts` back into its pre-#199 physical shape, regardless of
 * whether a previous run of this very test already tightened it (this
 * process's own prior `upgradeMailAccountsToConnectedAccounts` call, or an
 * unrelated earlier `pnpm test` against the same dev Postgres) — every
 * statement here is its own idempotent no-op otherwise.
 */
async function resetToLegacyShape(db: Db): Promise<void> {
  await db.execute(sql`ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS credential jsonb`);
  await db.execute(sql`ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS status text`);
  await db.execute(sql`ALTER TABLE mail_accounts ALTER COLUMN connected_account_id DROP NOT NULL`);
  await db.execute(
    sql`ALTER TABLE mail_accounts DROP CONSTRAINT IF EXISTS mail_accounts_connected_account_id_unique`,
  );
}

async function insertUser(): Promise<string> {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    username: `user-${userId}`,
    passwordHash: "not-a-real-hash",
    role: "owner",
  });
  return userId;
}

/**
 * A raw, legacy-shaped `mail_accounts` row — `connected_account_id` null,
 * `credential`/`status` still physically present. `id` is caller-chosen so
 * a test can seal the credential under it (the real ADR-0003 AAD a
 * pre-#199 row always used) before this ever writes it.
 */
async function insertLegacyMailAccount(input: {
  id: string;
  userId: string;
  emailAddress: string;
  credential: unknown;
  status: "active" | "needs_reauth";
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO mail_accounts (
      id, user_id, email_address, imap_host, imap_port, imap_security,
      smtp_host, smtp_port, smtp_security, username, credential, status
    ) VALUES (
      ${input.id}, ${input.userId}, ${input.emailAddress}, 'imap.example.com', 993, 'tls',
      'smtp.example.com', 587, 'starttls', ${input.emailAddress},
      ${JSON.stringify(input.credential)}::jsonb, ${input.status}
    )
  `);
}

describe("upgradeMailAccountsToConnectedAccounts", () => {
  it("gives a legacy password Mail Account a Connected Account and Mail Facet, re-sealed under the new id", async () => {
    const userId = await insertUser();
    const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
    const mailAccountId = randomUUID();
    await insertLegacyMailAccount({
      id: mailAccountId,
      userId,
      emailAddress: "vic@example.com",
      credential: sealPasswordCredential("swordfish", mailAccountId, key),
      status: "active",
    });

    await upgradeMailAccountsToConnectedAccounts(db, TEST_MAIL_CREDENTIAL_KEY);

    const mailAccount = await getMailAccountById(db, mailAccountId);
    if (!mailAccount) throw new Error("expected the Mail Account to still exist");
    expect(mailAccount.connectedAccountId).toBeTruthy();
    expect(mailAccount.status).toBe("active");
    expect(mailAccount.credential).toMatchObject({ kind: "password" });

    const connectedAccount = await getConnectedAccountById(db, mailAccount.connectedAccountId);
    if (!connectedAccount) throw new Error("expected a Connected Account to have been created");
    expect(connectedAccount).toMatchObject({
      userId,
      provider: "other_imap",
      identity: "vic@example.com",
      status: "active",
    });
    // Re-sealed (fresh IV, ADR-0003) rather than the ciphertext just copied
    // across — unsealable under the Connected Account's own id.
    expect(unsealPasswordCredential(mailAccount.credential, connectedAccount.id, key)).toBe(
      "swordfish",
    );
  });

  it("derives the Provider from an oauth credential and marks a needs_reauth account on both new rows", async () => {
    const userId = await insertUser();
    const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
    const mailAccountId = randomUUID();
    // The pre-#199 `oauth` shape (ADR-0003): one access token, not one per
    // audience — `sealLegacyOAuthCredential` below builds exactly that,
    // since the widened `sealOAuthCredential` (ADR-0022) no longer can.
    await insertLegacyMailAccount({
      id: mailAccountId,
      userId,
      emailAddress: "vic@gmail.com",
      credential: sealLegacyOAuthCredential(
        {
          provider: "google",
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: new Date().toISOString(),
          scope: ["https://mail.google.com/"],
        },
        mailAccountId,
        key,
      ),
      status: "needs_reauth",
    });

    await upgradeMailAccountsToConnectedAccounts(db, TEST_MAIL_CREDENTIAL_KEY);

    const mailAccount = await getMailAccountById(db, mailAccountId);
    expect(mailAccount?.status).toBe("needs_reauth");
    const connectedAccount = await getConnectedAccountById(
      db,
      mailAccount?.connectedAccountId ?? "",
    );
    expect(connectedAccount).toMatchObject({ provider: "google", status: "needs_reauth" });
  });

  it("tightens mail_accounts once every row is migrated: NOT NULL, unique, credential/status gone", async () => {
    await upgradeMailAccountsToConnectedAccounts(db, TEST_MAIL_CREDENTIAL_KEY);

    await expect(
      db.execute(sql`INSERT INTO mail_accounts (id) VALUES ('should-fail-not-null')`),
    ).rejects.toThrow();
    await expect(db.execute(sql`SELECT credential FROM mail_accounts LIMIT 1`)).rejects.toThrow();
    await expect(db.execute(sql`SELECT status FROM mail_accounts LIMIT 1`)).rejects.toThrow();
  });

  it("is idempotent: running it twice touches nothing the second time", async () => {
    const userId = await insertUser();
    const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
    const mailAccountId = randomUUID();
    await insertLegacyMailAccount({
      id: mailAccountId,
      userId,
      emailAddress: "vic@example.com",
      credential: sealPasswordCredential("swordfish", mailAccountId, key),
      status: "active",
    });

    await upgradeMailAccountsToConnectedAccounts(db, TEST_MAIL_CREDENTIAL_KEY);
    const first = await getMailAccountById(db, mailAccountId);

    await upgradeMailAccountsToConnectedAccounts(db, TEST_MAIL_CREDENTIAL_KEY);
    const second = await getMailAccountById(db, mailAccountId);

    expect(second?.connectedAccountId).toBe(first?.connectedAccountId);
    expect(second?.credential).toEqual(first?.credential);
  });
});
