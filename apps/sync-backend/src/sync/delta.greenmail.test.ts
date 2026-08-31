import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { messages, threads } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";
import { applyFolderDelta } from "./delta.js";
import { type FolderRow, findFolderByRole } from "./folders.js";
import { connectMailAccount } from "./imap-connection.js";
import { syncMailAccount } from "./sync-account.js";

/**
 * The UID-diff fallback (#35), end to end against GreenMail — the path
 * every GreenMail-backed live-sync test actually exercises, since GreenMail
 * advertises neither CONDSTORE nor QRESYNC (verified for this ticket; see
 * `docs/dev-setup.md`).
 */
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let otherClient: ImapFlow | null = null;

function at(day: number): Date {
  return new Date(Date.UTC(2025, 5, day, 9, 0, 0));
}

/** A second IMAP connection standing in for "another mail client" against the same mailbox. */
async function connectOtherClient(emailAddress: string): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: emailAddress, pass: "anything" },
    logger: false,
  });
  await client.connect();
  otherClient = client;
  return client;
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  const emailAddress = `delta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mail.test`;
  account = await createTestMailAccount(db, {
    emailAddress,
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
  });
});

afterEach(async () => {
  await otherClient?.logout().catch(() => undefined);
  otherClient?.close();
  otherClient = null;
});

afterAll(async () => {
  await closeDb?.();
});

async function inboxRow(): Promise<FolderRow> {
  const row = await findFolderByRole(db, account.id, "inbox");
  if (!row) throw new Error("INBOX was not discovered");
  return row;
}

describe("applyFolderDelta against GreenMail", () => {
  it("picks up a new message that arrived after the baseline sync", async () => {
    const other = await connectOtherClient(account.emailAddress);
    await other.append(
      "INBOX",
      buildTestMessage({
        from: "Alice Anderson <alice@example.test>",
        to: account.emailAddress,
        subject: "First message",
        date: at(1),
        messageId: "delta-a@example.test",
        text: "Hello.",
      }),
      [],
      at(1),
    );

    const baseline = await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      roles: ["inbox"],
    });
    if (baseline.status !== "synced") throw new Error("expected a sync");
    expect(baseline.ingest[0]?.created).toBe(1);

    await other.append(
      "INBOX",
      buildTestMessage({
        from: "Carol Chen <carol@example.test>",
        to: account.emailAddress,
        subject: "Second message",
        date: at(2),
        messageId: "delta-b@example.test",
        text: "Just landed.",
      }),
      [],
      at(2),
    );

    const client = await connectMailAccount(db, account, {
      credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
    });
    try {
      const result = await applyFolderDelta(db, client, await inboxRow());
      expect(result).toMatchObject({ created: 1, updated: 0, vanished: 0, rebuilt: false });
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }

    const stored = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.mailAccountId, account.id),
          eq(messages.messageIdHeader, "delta-b@example.test"),
        ),
      );
    expect(stored).toHaveLength(1);
  });

  it("applies a flag change made by another IMAP client", async () => {
    const other = await connectOtherClient(account.emailAddress);
    await other.append(
      "INBOX",
      buildTestMessage({
        from: "Alice Anderson <alice@example.test>",
        to: account.emailAddress,
        subject: "Read me",
        date: at(1),
        messageId: "delta-flag@example.test",
        text: "Hello.",
      }),
      [],
      at(1),
    );
    await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      roles: ["inbox"],
    });

    const [before] = await db
      .select()
      .from(messages)
      .where(eq(messages.messageIdHeader, "delta-flag@example.test"));
    expect(before).toMatchObject({ seen: false, flagged: false });

    // Another client reads and stars it.
    const lock = await other.getMailboxLock("INBOX");
    try {
      await other.messageFlagsAdd("1:*", ["\\Seen", "\\Flagged"]);
    } finally {
      lock.release();
    }

    const client = await connectMailAccount(db, account, {
      credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
    });
    try {
      const result = await applyFolderDelta(db, client, await inboxRow());
      expect(result).toMatchObject({ created: 0, updated: 1, vanished: 0 });
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }

    const [after] = await db
      .select()
      .from(messages)
      .where(eq(messages.messageIdHeader, "delta-flag@example.test"));
    expect(after).toMatchObject({ seen: true, flagged: true });

    const [thread] = await db
      .select()
      .from(threads)
      .where(eq(threads.id, after?.threadId ?? ""));
    expect(thread).toMatchObject({ starred: true, unreadCount: 0 });
  });

  it("removes a message another IMAP client expunged, and cleans up its Thread", async () => {
    const other = await connectOtherClient(account.emailAddress);
    await other.append(
      "INBOX",
      buildTestMessage({
        from: "Alice Anderson <alice@example.test>",
        to: account.emailAddress,
        subject: "Going away",
        date: at(1),
        messageId: "delta-gone@example.test",
        text: "Bye.",
      }),
      [],
      at(1),
    );
    await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      roles: ["inbox"],
    });

    const [before] = await db
      .select()
      .from(messages)
      .where(eq(messages.messageIdHeader, "delta-gone@example.test"));
    if (!before) throw new Error("seed message was not ingested");
    const threadId = before.threadId;

    const lock = await other.getMailboxLock("INBOX");
    try {
      await other.messageDelete("1:*");
    } finally {
      lock.release();
    }

    const client = await connectMailAccount(db, account, {
      credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
    });
    try {
      const result = await applyFolderDelta(db, client, await inboxRow());
      expect(result).toMatchObject({ created: 0, updated: 0, vanished: 1 });
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }

    const stored = await db.select().from(messages).where(eq(messages.id, before.id));
    expect(stored).toHaveLength(0);

    // The Thread had exactly this one message — it must not survive empty.
    const remainingThread = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(remainingThread).toHaveLength(0);
  });
});
