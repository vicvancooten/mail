import { and, eq, inArray } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, mailAccounts, messages, threads } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";
import { syncMailAccount } from "./sync-account.js";
import { GMAIL_SYNCED_ROLES } from "./sync-plan.js";

/**
 * The acceptance bar of #122 against a real Gmail account — the sync plan is
 * exactly All Mail/Spam/Trash/Drafts, and the Inbox predicate reads back a
 * real `\Inbox` label correctly. GreenMail cannot exercise any of this (no
 * `X-GM-EXT-1`, no `[Gmail]/All Mail`), so this is skipped unless a real
 * Gmail account is configured:
 *
 *   GMAIL_LIVE_TEST_EMAIL, GMAIL_LIVE_TEST_PASSWORD (an IMAP App Password —
 *   ADR-0020's own "selection is by server capability, not credential kind"
 *   means an app-password Gmail account exercises exactly the same sync
 *   plan a Google-sign-in Grant would; XOAUTH2 IMAP auth for a real Grant
 *   is not wired into `sync/imap-connection.ts` yet and is a separate
 *   ticket, not #122's),
 *   GMAIL_LIVE_TEST_HOST (default imap.gmail.com), GMAIL_LIVE_TEST_PORT
 *   (default 993).
 *
 * Uses a dedicated IMAP client, independent of the Mail Account under test,
 * to seed messages the way another mail client would — `syncMailAccount`
 * itself must never be what creates the fixtures it then reads back.
 */
const EMAIL = process.env.GMAIL_LIVE_TEST_EMAIL ?? "";
const PASSWORD = process.env.GMAIL_LIVE_TEST_PASSWORD ?? "";
const HOST = process.env.GMAIL_LIVE_TEST_HOST ?? "imap.gmail.com";
const PORT = Number(process.env.GMAIL_LIVE_TEST_PORT ?? 993);

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;

async function seederClient(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: EMAIL, pass: PASSWORD },
    logger: false,
  });
  await client.connect();
  return client;
}

beforeEach(async () => {
  if (!EMAIL) return;
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db, {
    emailAddress: EMAIL,
    password: PASSWORD,
    imapHost: HOST,
    imapPort: PORT,
  });
  const [updated] = await db
    .update(mailAccounts)
    .set({ imapSecurity: "tls", username: EMAIL })
    .where(eq(mailAccounts.id, account.id))
    .returning();
  if (updated) account = updated;
});

afterAll(async () => {
  await closeDb?.();
});

describe.skipIf(!EMAIL || !PASSWORD)("Gmail sync plan against a real Gmail account", () => {
  it("detects gmail and syncs only All Mail, Spam, Trash and Drafts", async () => {
    const result = await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      limitPerFolder: 1,
    });
    expect(result.status).toBe("synced");
    if (result.status !== "synced") return;

    const [refreshed] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    expect(refreshed?.serverKind).toBe("gmail");

    const syncedRoles = result.ingest.map((entry) => {
      const folder = result.folders.find((row) => row.id === entry.folderId);
      return folder?.role ?? null;
    });
    expect(new Set(syncedRoles)).toEqual(new Set(GMAIL_SYNCED_ROLES));
  });

  it("ingests a fresh Inbox message once, in the Inbox, carrying the \\Inbox label", async () => {
    const messageId = `gmail-live-inbox-${Date.now()}@example.test`;
    const seeder = await seederClient();
    try {
      await seeder.append(
        "INBOX",
        buildTestMessage({
          from: "Alice Anderson <alice@example.test>",
          to: EMAIL,
          subject: "Live Gmail Inbox test",
          date: new Date(),
          messageId,
          text: "Hi.",
        }),
        [],
        new Date(),
      );
    } finally {
      await seeder.logout().catch(() => undefined);
      seeder.close();
    }

    await syncMailAccount(db, account, { mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });

    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.mailAccountId, account.id), eq(messages.messageIdHeader, messageId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gmailLabels ?? []).toContain("\\Inbox");

    const [thread] = await db
      .select()
      .from(threads)
      .where(eq(threads.id, rows[0]?.threadId ?? ""));
    expect(thread).toMatchObject({ folderRole: "inbox", inInbox: true });
  });

  it("ingests a message filed under a user label but not the Inbox once, as archive", async () => {
    const label = `wicket-live-test-${Date.now()}`;
    const messageId = `gmail-live-label-${Date.now()}@example.test`;
    const seeder = await seederClient();
    try {
      await seeder.mailboxCreate(label);
      await seeder.append(
        label,
        buildTestMessage({
          from: "Carol Chen <carol@example.test>",
          to: EMAIL,
          subject: "Live Gmail label-only test",
          date: new Date(),
          messageId,
          text: "Hi.",
        }),
        [],
        new Date(),
      );
    } finally {
      await seeder.logout().catch(() => undefined);
      seeder.close();
    }

    await syncMailAccount(db, account, { mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });

    // The label Folder itself is never in the sync plan (#122) — only the
    // one copy Gmail also files into All Mail is ever ingested.
    const labelFolders = await db
      .select()
      .from(folders)
      .where(and(eq(folders.mailAccountId, account.id), inArray(folders.name, [label])));
    for (const folder of labelFolders) {
      const inLabelFolder = await db
        .select()
        .from(messages)
        .where(eq(messages.folderId, folder.id));
      expect(inLabelFolder).toHaveLength(0);
    }

    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.mailAccountId, account.id), eq(messages.messageIdHeader, messageId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gmailLabels ?? []).not.toContain("\\Inbox");

    const [thread] = await db
      .select()
      .from(threads)
      .where(eq(threads.id, rows[0]?.threadId ?? ""));
    expect(thread).toMatchObject({ folderRole: "archive", inInbox: false });
  });
});
