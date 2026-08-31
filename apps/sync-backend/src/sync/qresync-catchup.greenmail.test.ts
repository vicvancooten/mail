import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { findFolderByRole } from "./folders.js";
import { connectMailAccount } from "./imap-connection.js";
import { attemptQresyncCatchup } from "./qresync-catchup.js";
import { syncMailAccount } from "./sync-account.js";

/**
 * The GreenMail capability finding this ticket asked for (docs/dev-setup.md,
 * issue #35): `greenmail/standalone:2.1.8`'s `a1 CAPABILITY` answers
 * `IMAP4rev1 LITERAL+ UIDPLUS SORT IDLE MOVE SASL-IR AUTH=XOAUTH2 QUOTA` —
 * no `CONDSTORE`, no `QRESYNC`. This proves the live-sync loop's QRESYNC
 * attempt degrades to the UID-diff fallback there rather than erroring, so
 * every other GreenMail-backed test in this ticket is legitimately
 * exercising the fallback path, not accidentally skipping coverage.
 */
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db, {
    emailAddress: `qresync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mail.test`,
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
  });
});

afterAll(async () => {
  await closeDb?.();
});

describe("attemptQresyncCatchup against GreenMail", () => {
  it("does not advertise QRESYNC, so a connection asking for it never enables it", async () => {
    const client = await connectMailAccount(db, account, {
      credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
      qresync: true,
    });
    try {
      expect(client.capabilities.has("CONDSTORE")).toBe(false);
      expect(client.capabilities.has("QRESYNC")).toBe(false);
      expect(client.enabled.has("QRESYNC")).toBe(false);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }
  });

  it("falls through to null so the resident loop uses the UID-diff fallback instead", async () => {
    await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      roles: ["inbox"],
    });
    const inbox = await findFolderByRole(db, account.id, "inbox");
    if (!inbox) throw new Error("INBOX was not discovered");

    const client = await connectMailAccount(db, account, {
      credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
      qresync: true,
    });
    try {
      const result = await attemptQresyncCatchup(db, client, inbox);
      expect(result).toBeNull();
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }
  });
});
