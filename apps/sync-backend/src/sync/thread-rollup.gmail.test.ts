import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, messages, threads } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import type { FolderRow } from "./folders.js";
import { refreshThreadRollups } from "./thread-rollup.js";

/**
 * `refreshThreadRollups`'s Gmail projection (#122, ADR-0020): the one place
 * `sync/inbox.ts#projectGmailThreadStatus` is actually applied to a Thread.
 * A generic account's `folderRole`/`inInbox` are `sync/mutations.ts`'s own
 * field and must come out exactly as seeded — this is what proves the
 * rollup never touches them there.
 */
let db: Db;
let closeDb: () => Promise<void>;

async function seedFolder(
  accountId: string,
  role: FolderRow["role"],
  path: string,
): Promise<FolderRow> {
  const [row] = await db
    .insert(folders)
    .values({ id: randomUUID(), mailAccountId: accountId, path, name: path, role, uidValidity: 1 })
    .returning();
  if (!row) throw new Error("failed to seed folder");
  return row;
}

async function seedMessage(
  account: MailAccountRow,
  threadId: string,
  folder: FolderRow,
  gmailLabels: string[] | null,
): Promise<void> {
  await db.insert(messages).values({
    id: randomUUID(),
    mailAccountId: account.id,
    threadId,
    folderId: folder.id,
    uid: 1,
    uidValidity: 1,
    subject: "Hi",
    sentAt: new Date(),
    receivedAt: new Date(),
    flags: [],
    gmailLabels,
  });
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

describe("refreshThreadRollups — Gmail projection (#122)", () => {
  it("projects an \\Inbox-labelled All Mail message to inbox", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    const allMail = await seedFolder(account.id, "all", "[Gmail]/All Mail");
    const threadId = randomUUID();
    await db.insert(threads).values({ id: threadId, mailAccountId: account.id, subject: "Hi" });
    await seedMessage(account, threadId, allMail, ["\\Inbox"]);

    await refreshThreadRollups(db, [threadId]);

    const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread).toMatchObject({ folderRole: "inbox", inInbox: true });
  });

  it("projects an unlabelled All Mail message to archive", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    const allMail = await seedFolder(account.id, "all", "[Gmail]/All Mail");
    const threadId = randomUUID();
    await db.insert(threads).values({ id: threadId, mailAccountId: account.id, subject: "Hi" });
    await seedMessage(account, threadId, allMail, null);

    await refreshThreadRollups(db, [threadId]);

    const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread).toMatchObject({ folderRole: "archive", inInbox: false });
  });

  it("projects a message in the Trash Folder to trash regardless of labels", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    const trash = await seedFolder(account.id, "trash", "[Gmail]/Trash");
    const threadId = randomUUID();
    await db.insert(threads).values({ id: threadId, mailAccountId: account.id, subject: "Hi" });
    await seedMessage(account, threadId, trash, null);

    await refreshThreadRollups(db, [threadId]);

    const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread).toMatchObject({ folderRole: "trash", inInbox: false });
  });

  it("marks hasSentMessage when the only message carries \\Sent on All Mail (#123)", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    const allMail = await seedFolder(account.id, "all", "[Gmail]/All Mail");
    const threadId = randomUUID();
    await db.insert(threads).values({ id: threadId, mailAccountId: account.id, subject: "Hi" });
    await seedMessage(account, threadId, allMail, ["\\Sent"]);

    await refreshThreadRollups(db, [threadId]);

    const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread).toMatchObject({ hasSentMessage: true });
  });

  it("leaves a generic account's folderRole/inInbox exactly as seeded", async () => {
    const account = await createTestMailAccount(db, { serverKind: "generic" });
    const archive = await seedFolder(account.id, "archive", "Archive");
    const threadId = randomUUID();
    // Seeded as if `sync/mutations.ts`'s archive intent had already run —
    // the rollup must not recompute this on a non-Gmail account.
    await db.insert(threads).values({
      id: threadId,
      mailAccountId: account.id,
      subject: "Hi",
      folderRole: "archive",
      inInbox: false,
    });
    await seedMessage(account, threadId, archive, null);

    await refreshThreadRollups(db, [threadId]);

    const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread).toMatchObject({ folderRole: "archive", inInbox: false });
  });

  it("still reads the Sent Folder role for a generic account's hasSentMessage (#123)", async () => {
    const account = await createTestMailAccount(db, { serverKind: "generic" });
    const sent = await seedFolder(account.id, "sent", "Sent");
    const threadId = randomUUID();
    await db.insert(threads).values({ id: threadId, mailAccountId: account.id, subject: "Hi" });
    await seedMessage(account, threadId, sent, null);

    await refreshThreadRollups(db, [threadId]);

    const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(thread).toMatchObject({ hasSentMessage: true });
  });
});
