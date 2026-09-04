import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, messages, protocolWrites, threads } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";
import { connectMailAccount } from "./imap-connection.js";
import { drainProtocolWrites, enqueueProtocolWrites } from "./protocol-writes.js";
import { resolveThread } from "./threading.js";

/**
 * The acceptance bar of #42 ("star/read visible in another IMAP client
 * after sync; archive/trash moved server-side"), end to end against
 * GreenMail: real `STORE` and `MOVE` commands, verified from a second
 * connection standing in for "another mail client" — the same pattern
 * `delta.greenmail.test.ts` uses for the read-side equivalent.
 */
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let otherClient: ImapFlow | null = null;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  const emailAddress = `protocol-writes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mail.test`;
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

async function connectOtherClient(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: account.emailAddress, pass: "anything" },
    logger: false,
  });
  await client.connect();
  otherClient = client;
  return client;
}

/**
 * Appends one message to real INBOX, then stores exactly the rows
 * `sync/mutations.ts` would have written — a Thread, a Message row pointed
 * at the real UID, and (via `seedFolderRole`) whatever destination folders
 * this test needs. Bypasses `folders.ts`'s own SPECIAL-USE discovery on
 * purpose: this file is about `drainProtocolWrites`, not about whether
 * GreenMail advertises `\Archive`/`\Trash`.
 */
async function seedInboxMessage(other: ImapFlow): Promise<{ threadId: string; messageId: string }> {
  const inboxFolderId = await seedFolderRole("inbox", "INBOX");
  await other.append(
    "INBOX",
    buildTestMessage({
      from: "Alice Anderson <alice@example.test>",
      to: account.emailAddress,
      subject: "Write-through",
      date: new Date("2026-01-01T09:00:00Z"),
      messageId: "write-through@example.test",
      text: "Hello.",
    }),
    [],
    new Date("2026-01-01T09:00:00Z"),
  );

  const threadId = await resolveThread(db, {
    mailAccountId: account.id,
    threadingIds: ["write-through@example.test"],
    subject: "Write-through",
    receivedAt: new Date("2026-01-01T09:00:00Z"),
  });
  const messageId = randomUUID();
  await db.insert(messages).values({
    id: messageId,
    mailAccountId: account.id,
    threadId,
    folderId: inboxFolderId,
    uid: 1, // GreenMail assigns UID 1 to the first message in a fresh mailbox.
    messageIdHeader: "write-through@example.test",
    subject: "Write-through",
    sentAt: new Date("2026-01-01T09:00:00Z"),
    receivedAt: new Date("2026-01-01T09:00:00Z"),
    // `sync/mutations.ts` sets these synchronously *before* enqueueing the
    // outbox row (`applyIntent`'s own write happens first) — the drain
    // reads whatever is here as the value already decided, it never carries
    // its own. Seeded true so the seen/flagged test below exercises the
    // "add" branch, matching a real setStarred/setRead(true).
    seen: true,
    flagged: true,
  });
  return { threadId, messageId };
}

async function seedFolderRole(role: "inbox" | "archive" | "trash", path: string): Promise<string> {
  const id = randomUUID();
  await db.insert(folders).values({ id, mailAccountId: account.id, path, name: path, role });
  return id;
}

async function messageRow(messageId: string) {
  const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!row) throw new Error("message row vanished");
  return row;
}

/** How many messages a folder holds right now, per a fresh `SELECT`. */
async function mailboxCount(client: ImapFlow, path: string): Promise<number> {
  const lock = await client.getMailboxLock(path);
  try {
    return client.mailbox === false ? -1 : client.mailbox.exists;
  } finally {
    lock.release();
  }
}

describe("drainProtocolWrites against GreenMail", () => {
  it("writes \\Seen and \\Flagged through to the real message", async () => {
    const other = await connectOtherClient();
    const { messageId } = await seedInboxMessage(other);
    await enqueueProtocolWrites(db, account.id, [messageId], "seen");
    await enqueueProtocolWrites(db, account.id, [messageId], "flagged");

    const client = await connectMailAccount(db, account, {
      credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
    });
    try {
      const applied = await drainProtocolWrites(db, client, account.id);
      expect(applied).toBe(2);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }

    // Verified from a second connection — "visible in another IMAP client".
    const lock = await other.getMailboxLock("INBOX");
    let flags: Set<string> | undefined;
    try {
      for await (const message of other.fetch("1:*", { flags: true })) flags = message.flags;
    } finally {
      lock.release();
    }
    expect(flags?.has("\\Seen")).toBe(true);
    expect(flags?.has("\\Flagged")).toBe(true);

    expect(
      await db.select().from(protocolWrites).where(eq(protocolWrites.mailAccountId, account.id)),
    ).toHaveLength(0);
  });

  it("moves the message to Archive over a real IMAP MOVE, and updates its stored folder/uid", async () => {
    const other = await connectOtherClient();
    const { threadId, messageId } = await seedInboxMessage(other);
    const archiveFolderId = await seedFolderRole("archive", "Archive");
    await other.mailboxCreate("Archive");
    await db.update(threads).set({ inInbox: false }).where(eq(threads.id, threadId));
    await enqueueProtocolWrites(db, account.id, [messageId], "archive");

    const client = await connectMailAccount(db, account, {
      credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
    });
    try {
      const applied = await drainProtocolWrites(db, client, account.id);
      expect(applied).toBe(1);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }

    // The real mailbox: gone from INBOX, present in Archive — "archive moved server-side".
    expect(await mailboxCount(other, "INBOX")).toBe(0);
    expect(await mailboxCount(other, "Archive")).toBe(1);

    const updated = await messageRow(messageId);
    expect(updated.folderId).toBe(archiveFolderId);

    expect(
      await db.select().from(protocolWrites).where(eq(protocolWrites.mailAccountId, account.id)),
    ).toHaveLength(0);
  });

  it("moves the message back from Trash to Inbox over a real IMAP MOVE — Undo's own inverse (#95, ADR-0019)", async () => {
    const other = await connectOtherClient();
    const inboxFolderId = await seedFolderRole("inbox", "INBOX");
    const trashFolderId = await seedFolderRole("trash", "Trash");
    await other.mailboxCreate("Trash");
    await other.append(
      "Trash",
      buildTestMessage({
        from: "Alice Anderson <alice@example.test>",
        to: account.emailAddress,
        subject: "Restore me",
        date: new Date("2026-01-01T09:00:00Z"),
        messageId: "restore-me@example.test",
        text: "Hello.",
      }),
      [],
      new Date("2026-01-01T09:00:00Z"),
    );
    const threadId = await resolveThread(db, {
      mailAccountId: account.id,
      threadingIds: ["restore-me@example.test"],
      subject: "Restore me",
      receivedAt: new Date("2026-01-01T09:00:00Z"),
    });
    const messageId = randomUUID();
    await db.insert(messages).values({
      id: messageId,
      mailAccountId: account.id,
      threadId,
      folderId: trashFolderId,
      uid: 1, // GreenMail's first message in a fresh Trash mailbox.
      messageIdHeader: "restore-me@example.test",
      subject: "Restore me",
      sentAt: new Date("2026-01-01T09:00:00Z"),
      receivedAt: new Date("2026-01-01T09:00:00Z"),
    });
    await db
      .update(threads)
      .set({ inInbox: false, folderRole: "trash" })
      .where(eq(threads.id, threadId));
    await enqueueProtocolWrites(db, account.id, [messageId], "inbox");

    const client = await connectMailAccount(db, account, {
      credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
    });
    try {
      const applied = await drainProtocolWrites(db, client, account.id);
      expect(applied).toBe(1);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }

    // The real mailbox: gone from Trash, present in INBOX — restored, not just marked so.
    expect(await mailboxCount(other, "Trash")).toBe(0);
    expect(await mailboxCount(other, "INBOX")).toBe(1);

    const updated = await messageRow(messageId);
    expect(updated.folderId).toBe(inboxFolderId);

    expect(
      await db.select().from(protocolWrites).where(eq(protocolWrites.mailAccountId, account.id)),
    ).toHaveLength(0);
  });

  it("leaves the row queued when there is no matching Archive/Trash folder to move into", async () => {
    const other = await connectOtherClient();
    const { messageId } = await seedInboxMessage(other);
    await enqueueProtocolWrites(db, account.id, [messageId], "trash"); // no "trash" role folder seeded

    const client = await connectMailAccount(db, account, {
      credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
    });
    try {
      const applied = await drainProtocolWrites(db, client, account.id);
      expect(applied).toBe(0);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }

    expect(
      await db
        .select()
        .from(protocolWrites)
        .where(
          and(
            eq(protocolWrites.mailAccountId, account.id),
            eq(protocolWrites.messageId, messageId),
          ),
        ),
    ).toHaveLength(1);
  });
});
