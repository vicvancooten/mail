import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { mailAccounts, messages } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";
import { findFolderByRole } from "./folders.js";
import { connectMailAccount } from "./imap-connection.js";
import { attemptQresyncCatchup } from "./qresync-catchup.js";
import { syncMailAccount } from "./sync-account.js";

/**
 * The real SELECT-with-QRESYNC exchange this ticket asked to put "behind an
 * integration test that can also run against a real server" — GreenMail
 * cannot exercise it (`qresync-catchup.greenmail.test.ts`, docs/dev-setup.md
 * capability findings), so this one is skipped unless a QRESYNC-capable
 * server (Dovecot with `mail_plugins = quota imap_quota` is not enough — it
 * needs `imap_capability = +CONDSTORE +QRESYNC`, on by default in modern
 * Dovecot) is pointed at via env vars:
 *
 *   IMAP_QRESYNC_TEST_HOST, IMAP_QRESYNC_TEST_PORT (default 993),
 *   IMAP_QRESYNC_TEST_SECURITY ("tls" | "starttls" | "none", default "tls"),
 *   IMAP_QRESYNC_TEST_USER, IMAP_QRESYNC_TEST_PASSWORD
 */
const HOST = process.env.IMAP_QRESYNC_TEST_HOST;
const PORT = Number(process.env.IMAP_QRESYNC_TEST_PORT ?? 993);
const SECURITY = (process.env.IMAP_QRESYNC_TEST_SECURITY ?? "tls") as "tls" | "starttls" | "none";
const USER = process.env.IMAP_QRESYNC_TEST_USER ?? "";
const PASSWORD = process.env.IMAP_QRESYNC_TEST_PASSWORD ?? "";

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;

beforeEach(async () => {
  if (!HOST) return;
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db, {
    emailAddress: USER,
    imapHost: HOST,
    imapPort: PORT,
  });
  // `createTestMailAccount` always writes `imapSecurity: "none"` (GreenMail's
  // convention) — a real server almost never allows that.
  const [updated] = await db
    .update(mailAccounts)
    .set({ imapSecurity: SECURITY, username: USER })
    .where(eq(mailAccounts.id, account.id))
    .returning();
  if (updated) account = updated;
});

afterAll(async () => {
  await closeDb?.();
});

describe.skipIf(!HOST || !USER || !PASSWORD)(
  "attemptQresyncCatchup against a real QRESYNC-capable server",
  () => {
    it("advertises and enables QRESYNC", async () => {
      const client = await connectMailAccount(db, account, {
        credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
        qresync: true,
      });
      try {
        expect(client.capabilities.has("QRESYNC")).toBe(true);
        expect(client.enabled.has("QRESYNC")).toBe(true);
      } finally {
        await client.logout().catch(() => undefined);
        client.close();
      }
    });

    it("picks up a flag change and a new arrival made while disconnected", async () => {
      await syncMailAccount(db, account, {
        mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
        roles: ["inbox"],
      });
      const inbox = await findFolderByRole(db, account.id, "inbox");
      if (!inbox) throw new Error("INBOX was not discovered");

      // Simulate "changes happened while our session was closed": a second
      // connection stars an existing message and appends a new one.
      const other = new ImapFlow({
        // `describe.skipIf` above guarantees this suite only runs with HOST set.
        host: HOST as string,
        port: PORT,
        secure: SECURITY === "tls",
        auth: { user: USER, pass: PASSWORD },
        logger: false,
      });
      await other.connect();
      try {
        await other.append(
          "INBOX",
          buildTestMessage({
            from: "Alice Anderson <alice@example.test>",
            to: account.emailAddress,
            subject: "Arrived while disconnected",
            date: new Date(),
            messageId: `qresync-live-${Date.now()}@example.test`,
            text: "Hi.",
          }),
          [],
          new Date(),
        );
        const lock = await other.getMailboxLock("INBOX");
        try {
          await other.messageFlagsAdd("1", ["\\Flagged"]);
        } finally {
          lock.release();
        }
      } finally {
        await other.logout().catch(() => undefined);
        other.close();
      }

      const client = await connectMailAccount(db, account, {
        credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
        qresync: true,
      });
      try {
        const result = await attemptQresyncCatchup(db, client, inbox);
        expect(result).not.toBeNull();
        expect(result?.created).toBeGreaterThanOrEqual(1);
      } finally {
        await client.logout().catch(() => undefined);
        client.close();
      }

      const flagged = await db
        .select()
        .from(messages)
        .where(and(eq(messages.mailAccountId, account.id), eq(messages.flagged, true)));
      expect(flagged.length).toBeGreaterThanOrEqual(1);
    });
  },
);
