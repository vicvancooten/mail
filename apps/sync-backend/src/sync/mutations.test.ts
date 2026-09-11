import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES, labelId } from "@mail/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  appliedMutations,
  calendars,
  compositions,
  events,
  folders,
  labels,
  messages,
  notes,
  protocolWrites,
  reminderDue,
  series,
  syncTombstones,
  taskLists,
  tasks,
  threads,
  users,
} from "../db/schema.js";
import { resolveVerdict } from "../gatekeeper/verdicts.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { flushMutations, flushUserMutations } from "./mutations.js";
import { refreshThreadRollups } from "./thread-rollup.js";
import { resolveThread } from "./threading.js";

/**
 * `sync/mutations.ts` against a real Postgres — the idempotency ledger and
 * `\Seen`/`\Flagged` writes are statements, not pure functions, and the
 * interesting property (a retried id never re-applies) only exists at the
 * database boundary.
 */
let db: Db;
let closeDb: (() => Promise<void>) | undefined;
let account: MailAccountRow;

beforeEach(async () => {
  // Closes the previous test's own pool before opening a fresh one — this
  // file's own `beforeEach`/`afterAll` split (closing only the very last
  // pool) otherwise leaks one `postgres.js` connection per test, and this is
  // now the one file in the suite with enough cases (113, #251's own Task
  // cases pushed it past the mark) to exhaust the dev Postgres' own
  // `max_connections` before `afterAll` ever runs.
  await closeDb?.();
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db);
});

afterAll(async () => {
  await closeDb?.();
});

/** Inserts a Folder with the given special-use role, the way `folders.ts` would have discovered it. */
async function seedFolder(
  role: "inbox" | "archive" | "trash" | "sent" | "junk",
  path: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(folders).values({ id, mailAccountId: account.id, path, name: path, role });
  return id;
}

/** One Thread with one Message in a freshly seeded INBOX, the way `ingest.ts` would have stored it. */
async function seedThread(overrides: { seen?: boolean; flagged?: boolean } = {}): Promise<string> {
  const threadId = await resolveThread(db, {
    mailAccountId: account.id,
    threadingIds: [randomUUID()],
    subject: "Test",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
  });
  const folderId = await seedFolder("inbox", "INBOX");
  await db.insert(messages).values({
    id: randomUUID(),
    mailAccountId: account.id,
    threadId,
    folderId,
    uid: 1,
    subject: "Test",
    sentAt: new Date("2026-01-01T00:00:00Z"),
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    seen: overrides.seen ?? false,
    flagged: overrides.flagged ?? false,
  });
  return threadId;
}

/** Adds a second Message to an existing Thread, in a folder of the given role — a Sent self-copy, say. */
async function addMessageInFolder(
  threadId: string,
  role: "inbox" | "sent",
  uid: number,
): Promise<string> {
  const folderId = await seedFolder(role, role.toUpperCase());
  const id = randomUUID();
  await db.insert(messages).values({
    id,
    mailAccountId: account.id,
    threadId,
    folderId,
    uid,
    subject: "Test",
    sentAt: new Date("2026-01-01T00:00:00Z"),
    receivedAt: new Date("2026-01-01T00:00:00Z"),
  });
  return id;
}

async function threadRow(threadId: string) {
  const [row] = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
  return row;
}

async function outboxRows(mailAccountId: string) {
  return db.select().from(protocolWrites).where(eq(protocolWrites.mailAccountId, mailAccountId));
}

describe("flushMutations", () => {
  it("applies setStarred and setRead, reflected on the Thread rollup", async () => {
    const threadId = await seedThread();

    const outcomes = await flushMutations(db, account.id, [
      { id: "01A", intent: { type: "setStarred", threadId, starred: true } },
      { id: "01B", intent: { type: "setRead", threadId, read: true } },
    ]);

    expect(outcomes).toEqual([
      { id: "01A", status: "applied" },
      { id: "01B", status: "applied" },
    ]);
    const row = await threadRow(threadId);
    expect(row?.starred).toBe(true);
    expect(row?.unreadCount).toBe(0);
  });

  it("queues the write-through outbox for setStarred/setRead (ADR-0006's asynchronous IMAP mirror)", async () => {
    const threadId = await seedThread();

    await flushMutations(db, account.id, [
      { id: "01A", intent: { type: "setStarred", threadId, starred: true } },
      { id: "01B", intent: { type: "setRead", threadId, read: true } },
    ]);

    const rows = await outboxRows(account.id);
    expect(rows.map((row) => row.kind).sort()).toEqual(["flagged", "seen"]);
  });

  it("is idempotent: replaying an already-applied id never re-applies it", async () => {
    const threadId = await seedThread({ flagged: false });

    const first = await flushMutations(db, account.id, [
      { id: "01SAME", intent: { type: "setStarred", threadId, starred: true } },
    ]);
    expect(first).toEqual([{ id: "01SAME", status: "applied" }]);

    // Change the underlying message directly, bypassing the rollup, so a
    // *re-applying* retry would be observable: it would call
    // `refreshThreadRollups` again and pick up `flagged: false`, flipping
    // `threads.starred` back. A genuinely idempotent retry never touches
    // the message row or the rollup at all, so `starred` stays `true`.
    await db.update(messages).set({ flagged: false }).where(eq(messages.threadId, threadId));

    const retry = await flushMutations(db, account.id, [
      { id: "01SAME", intent: { type: "setStarred", threadId, starred: true } },
    ]);
    expect(retry).toEqual([{ id: "01SAME", status: "applied" }]);

    const ledgerRows = await db
      .select()
      .from(appliedMutations)
      .where(eq(appliedMutations.id, "01SAME"));
    expect(ledgerRows).toHaveLength(1);
    const row = await threadRow(threadId);
    expect(row?.starred).toBe(true);
  });

  it("rejects a mutation naming a Thread this Mail Account does not have", async () => {
    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01MISSING",
        intent: { type: "setStarred", threadId: "does-not-exist", starred: true },
      },
    ]);
    expect(outcomes).toEqual([{ id: "01MISSING", status: "rejected", reason: "thread_not_found" }]);
  });

  it("processes every queued mutation in array order even after an earlier one is rejected", async () => {
    const threadId = await seedThread();

    const outcomes = await flushMutations(db, account.id, [
      { id: "01FAIL", intent: { type: "setStarred", threadId: "ghost", starred: true } },
      { id: "01OK", intent: { type: "setStarred", threadId, starred: true } },
    ]);

    expect(outcomes.map((outcome) => outcome.id)).toEqual(["01FAIL", "01OK"]);
    expect(outcomes[0]?.status).toBe("rejected");
    expect(outcomes[1]?.status).toBe("applied");
    expect((await threadRow(threadId))?.starred).toBe(true);
  });

  it("does not let a mutation act on a Thread belonging to a different Mail Account", async () => {
    const other = await createTestMailAccount(db);
    const threadId = await seedThread();

    const outcomes = await flushMutations(db, other.id, [
      { id: "01CROSS", intent: { type: "setStarred", threadId, starred: true } },
    ]);

    expect(outcomes).toEqual([{ id: "01CROSS", status: "rejected", reason: "thread_not_found" }]);
    expect((await threadRow(threadId))?.starred).toBe(false);
  });
});

describe("flushMutations — archive/trash (#42)", () => {
  it("flips inInbox synchronously and queues the Inbox Message for a real IMAP move", async () => {
    const threadId = await seedThread();
    await seedFolder("archive", "Archive");

    const outcomes = await flushMutations(db, account.id, [
      { id: "01ARCHIVE", intent: { type: "archive", threadId } },
    ]);

    expect(outcomes).toEqual([{ id: "01ARCHIVE", status: "applied" }]);
    expect((await threadRow(threadId))?.inInbox).toBe(false);
    const rows = await outboxRows(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "archive" });
  });

  it("trash behaves the same way, against the Trash role", async () => {
    const threadId = await seedThread();
    await seedFolder("trash", "Trash");

    const outcomes = await flushMutations(db, account.id, [
      { id: "01TRASH", intent: { type: "trash", threadId } },
    ]);

    expect(outcomes).toEqual([{ id: "01TRASH", status: "applied" }]);
    expect((await threadRow(threadId))?.inInbox).toBe(false);
    expect((await outboxRows(account.id))[0]).toMatchObject({ kind: "trash" });
  });

  it("only queues the Thread's Inbox-resident Messages — a Sent self-copy stays put", async () => {
    const threadId = await seedThread();
    await addMessageInFolder(threadId, "sent", 7);
    await seedFolder("archive", "Archive");

    await flushMutations(db, account.id, [
      { id: "01ARCHIVE", intent: { type: "archive", threadId } },
    ]);

    const rows = await outboxRows(account.id);
    expect(rows).toHaveLength(1); // the Inbox copy only, not the Sent one
  });

  it("is a no-op success on a Thread with no Inbox-resident Message left", async () => {
    const threadId = await seedThread();
    await addMessageInFolder(threadId, "sent", 7);
    await db.delete(messages).where(and(eq(messages.threadId, threadId), eq(messages.uid, 1))); // drop the seeded Inbox copy
    await seedFolder("archive", "Archive");

    const outcomes = await flushMutations(db, account.id, [
      { id: "01ARCHIVE", intent: { type: "archive", threadId } },
    ]);

    expect(outcomes).toEqual([{ id: "01ARCHIVE", status: "applied" }]);
    expect(await outboxRows(account.id)).toHaveLength(0);
  });

  it(
    "rejects — and the Client's optimistic hide rolls back visibly — when the account has no Archive " +
      "folder to move into",
    async () => {
      const threadId = await seedThread(); // no "archive" role folder seeded

      const outcomes = await flushMutations(db, account.id, [
        { id: "01NOARCHIVE", intent: { type: "archive", threadId } },
      ]);

      expect(outcomes).toEqual([
        { id: "01NOARCHIVE", status: "rejected", reason: "no_archive_folder" },
      ]);
      // Rejected outright: `inInbox` never flips, so there is nothing for the
      // Client to have to un-hide either — the overlay's rollback (a row
      // deletion, ADR-0010) is enough on its own.
      expect((await threadRow(threadId))?.inInbox).toBe(true);
      expect(await outboxRows(account.id)).toHaveLength(0);
    },
  );

  it("rejects a trash naming a Thread this Mail Account does not have", async () => {
    const outcomes = await flushMutations(db, account.id, [
      { id: "01MISSING", intent: { type: "trash", threadId: "does-not-exist" } },
    ]);
    expect(outcomes).toEqual([{ id: "01MISSING", status: "rejected", reason: "thread_not_found" }]);
  });

  it("archiving a still-snoozed Thread clears snoozeUntil (#76): Archive overrides Snooze", async () => {
    const threadId = await seedThread();
    await seedFolder("archive", "Archive");
    await db
      .update(threads)
      .set({ snoozeUntil: new Date(Date.now() + 60_000) })
      .where(eq(threads.id, threadId));

    await flushMutations(db, account.id, [
      { id: "01ARCHIVE", intent: { type: "archive", threadId } },
    ]);

    expect((await threadRow(threadId))?.snoozeUntil).toBeNull();
  });
});

describe("flushMutations — archive/trash on Gmail (#124, ADR-0020)", () => {
  /** One Thread with one Message on the All Mail Folder, the way #122's ingest would have stored it. */
  async function seedGmailThread(
    gmailAccountId: string,
    gmailLabels: string[] | null,
  ): Promise<string> {
    const threadId = await resolveThread(db, {
      mailAccountId: gmailAccountId,
      threadingIds: [randomUUID()],
      subject: "Test",
      receivedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const allMailId = randomUUID();
    await db.insert(folders).values({
      id: allMailId,
      mailAccountId: gmailAccountId,
      path: "[Gmail]/All Mail",
      name: "All Mail",
      role: "all",
    });
    await db.insert(messages).values({
      id: randomUUID(),
      mailAccountId: gmailAccountId,
      threadId,
      folderId: allMailId,
      uid: 1,
      subject: "Test",
      sentAt: new Date("2026-01-01T00:00:00Z"),
      receivedAt: new Date("2026-01-01T00:00:00Z"),
      gmailLabels,
    });
    return threadId;
  }

  it("archive enqueues a label-remove of \\Inbox on the All Mail UID, never a move, with no Archive Folder required", async () => {
    const gmailAccount = await createTestMailAccount(db, { serverKind: "gmail" });
    const threadId = await seedGmailThread(gmailAccount.id, ["\\Inbox"]);
    // Deliberately no "archive" role Folder seeded — Gmail never has one (#124).

    const outcomes = await flushMutations(db, gmailAccount.id, [
      { id: "01ARCHIVE", intent: { type: "archive", threadId } },
    ]);

    expect(outcomes).toEqual([{ id: "01ARCHIVE", status: "applied" }]);
    expect((await threadRow(threadId))?.inInbox).toBe(false);
    const rows = await outboxRows(gmailAccount.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "archive" });
  });

  it("strips the \\Inbox label synchronously, so a rollup recompute before the real removal drains doesn't republish the Thread as still in the Inbox (ADR-0010's 2026-09-11 amendment)", async () => {
    const gmailAccount = await createTestMailAccount(db, { serverKind: "gmail" });
    const threadId = await seedGmailThread(gmailAccount.id, ["\\Inbox"]);

    await flushMutations(db, gmailAccount.id, [
      { id: "01ARCHIVE", intent: { type: "archive", threadId } },
    ]);

    const [message] = await db.select().from(messages).where(eq(messages.threadId, threadId));
    expect(message?.gmailLabels).not.toContain("\\Inbox");

    // A rollup recompute racing the still-queued label-remove protocol write
    // (an unrelated message landing in the Thread, say) must agree with the
    // mutation already applied above, not overwrite it back to "inbox" from
    // a stale label.
    await refreshThreadRollups(db, [threadId]);
    const row = await threadRow(threadId);
    expect(row?.inInbox).toBe(false);
    expect(row?.folderRole).toBe("archive");
  });

  it("restoreToInbox enqueues a label-add of \\Inbox for a Gmail account", async () => {
    const gmailAccount = await createTestMailAccount(db, { serverKind: "gmail" });
    const threadId = await seedGmailThread(gmailAccount.id, null); // archived: no \Inbox label
    await db
      .update(threads)
      .set({ inInbox: false, folderRole: "archive" })
      .where(eq(threads.id, threadId));

    const outcomes = await flushMutations(db, gmailAccount.id, [
      { id: "01RESTORE", intent: { type: "restoreToInbox", threadId } },
    ]);

    expect(outcomes).toEqual([{ id: "01RESTORE", status: "applied" }]);
    const row = await threadRow(threadId);
    expect(row?.inInbox).toBe(true);
    const rows = await outboxRows(gmailAccount.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "inbox" });
  });

  it("trash still requires and enqueues a real move to the Trash Folder on Gmail", async () => {
    const gmailAccount = await createTestMailAccount(db, { serverKind: "gmail" });
    const threadId = await seedGmailThread(gmailAccount.id, ["\\Inbox"]);
    await db.insert(folders).values({
      id: randomUUID(),
      mailAccountId: gmailAccount.id,
      path: "[Gmail]/Trash",
      name: "Trash",
      role: "trash",
    });

    const outcomes = await flushMutations(db, gmailAccount.id, [
      { id: "01TRASH", intent: { type: "trash", threadId } },
    ]);

    expect(outcomes).toEqual([{ id: "01TRASH", status: "applied" }]);
    const rows = await outboxRows(gmailAccount.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "trash" });
  });

  it("rejects trash on a Gmail account with no Trash Folder — Trash stays a real move even there", async () => {
    const gmailAccount = await createTestMailAccount(db, { serverKind: "gmail" });
    const threadId = await seedGmailThread(gmailAccount.id, ["\\Inbox"]); // no "trash" role Folder seeded

    const outcomes = await flushMutations(db, gmailAccount.id, [
      { id: "01NOTRASH", intent: { type: "trash", threadId } },
    ]);

    expect(outcomes).toEqual([{ id: "01NOTRASH", status: "rejected", reason: "no_trash_folder" }]);
  });

  it("archive strips \\Inbox off the Message so the Thread stays out of the Inbox across a rollup that runs before the protocol drain (#278)", async () => {
    const gmailAccount = await createTestMailAccount(db, { serverKind: "gmail" });
    const threadId = await seedGmailThread(gmailAccount.id, ["\\Inbox"]);

    await flushMutations(db, gmailAccount.id, [
      { id: "01ARCHIVE", intent: { type: "archive", threadId } },
    ]);
    expect((await threadRow(threadId))?.inInbox).toBe(false);

    // The protocol write loop has not drained yet — nothing here has told
    // Gmail anything. A rollup running in that gap (any later poll cycle
    // touching this Thread) is exactly the bug #278 exists to fix: without
    // the optimistic label write, this call would recompute `inInbox: true`
    // straight off the still-`\Inbox`-labelled Message and republish it.
    await refreshThreadRollups(db, [threadId]);

    const row = await threadRow(threadId);
    expect(row?.inInbox).toBe(false);
    expect(row?.folderRole).toBe("archive");
    const [message] = await db.select().from(messages).where(eq(messages.threadId, threadId));
    expect(message?.gmailLabels).toEqual([]);
  });

  it("trash also strips \\Inbox off the Message, so the Thread stays out of the Inbox across the same rollup gap (#278)", async () => {
    const gmailAccount = await createTestMailAccount(db, { serverKind: "gmail" });
    const threadId = await seedGmailThread(gmailAccount.id, ["\\Inbox"]);
    await db.insert(folders).values({
      id: randomUUID(),
      mailAccountId: gmailAccount.id,
      path: "[Gmail]/Trash",
      name: "Trash",
      role: "trash",
    });

    await flushMutations(db, gmailAccount.id, [
      { id: "01TRASH", intent: { type: "trash", threadId } },
    ]);
    await refreshThreadRollups(db, [threadId]);

    expect((await threadRow(threadId))?.inInbox).toBe(false);
    const [message] = await db.select().from(messages).where(eq(messages.threadId, threadId));
    expect(message?.gmailLabels).toEqual([]);
  });
});

describe("flushMutations — restoreToInbox (#95, ADR-0019)", () => {
  it("moves an archived Thread back to Inbox and queues its Message for a real IMAP move", async () => {
    const threadId = await seedThread();
    await seedFolder("archive", "Archive");
    await db
      .update(threads)
      .set({ inInbox: false, folderRole: "archive" })
      .where(eq(threads.id, threadId));
    // The Message itself has to actually sit in the Archive folder for the
    // restore to find anything resident to move — `seedThread` puts it in
    // the seeded "inbox" folder, so this moves it the way `archive`'s own
    // handler would have.
    const archiveFolderId = (
      await db.select({ id: folders.id }).from(folders).where(eq(folders.role, "archive"))
    )[0]?.id;
    await db
      .update(messages)
      .set({ folderId: archiveFolderId })
      .where(eq(messages.threadId, threadId));

    const outcomes = await flushMutations(db, account.id, [
      { id: "01RESTORE", intent: { type: "restoreToInbox", threadId } },
    ]);

    expect(outcomes).toEqual([{ id: "01RESTORE", status: "applied" }]);
    const row = await threadRow(threadId);
    expect(row?.inInbox).toBe(true);
    expect(row?.folderRole).toBe("inbox");
    const rows = await outboxRows(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "inbox" });
  });

  it("is a no-op success on a Thread with nothing resident in Archive/Trash to restore", async () => {
    const threadId = await seedThread(); // already sitting in Inbox

    const outcomes = await flushMutations(db, account.id, [
      { id: "01RESTORE", intent: { type: "restoreToInbox", threadId } },
    ]);

    expect(outcomes).toEqual([{ id: "01RESTORE", status: "applied" }]);
    expect(await outboxRows(account.id)).toHaveLength(0);
  });

  it("rejects a restoreToInbox naming a Thread this Mail Account does not have", async () => {
    const outcomes = await flushMutations(db, account.id, [
      { id: "01MISSING", intent: { type: "restoreToInbox", threadId: "does-not-exist" } },
    ]);
    expect(outcomes).toEqual([{ id: "01MISSING", status: "rejected", reason: "thread_not_found" }]);
  });
});

describe("flushMutations — unsnooze (#95)", () => {
  it("clears snoozeUntil and flips inInbox back to true, with no protocol write", async () => {
    const threadId = await seedThread();
    await db
      .update(threads)
      .set({ inInbox: false, snoozeUntil: new Date(Date.now() + 60_000) })
      .where(eq(threads.id, threadId));

    const outcomes = await flushMutations(db, account.id, [
      { id: "01UNSNOOZE", intent: { type: "unsnooze", threadId } },
    ]);

    expect(outcomes).toEqual([{ id: "01UNSNOOZE", status: "applied" }]);
    const row = await threadRow(threadId);
    expect(row?.inInbox).toBe(true);
    expect(row?.snoozeUntil).toBeNull();
    expect(await outboxRows(account.id)).toHaveLength(0);
  });

  it("rejects an unsnooze naming a Thread this Mail Account does not have", async () => {
    const outcomes = await flushMutations(db, account.id, [
      { id: "01MISSING", intent: { type: "unsnooze", threadId: "does-not-exist" } },
    ]);
    expect(outcomes).toEqual([{ id: "01MISSING", status: "rejected", reason: "thread_not_found" }]);
  });

  it("is a true no-op on a Thread that was archived, not snoozed (#90's review)", async () => {
    // A Thread with `snoozeUntil: null` that has since been archived — the
    // exact shape a stale/racing `unsnooze` (Undo of a `snooze` that lost
    // the race to a later, more deliberate archive) would see. Without the
    // `snoozeUntil` guard this un-triaged it back into the Inbox.
    await seedFolder("archive", "Archive");
    const threadId = await seedThread();
    await db
      .update(threads)
      .set({ inInbox: false, folderRole: "archive", snoozeUntil: null })
      .where(eq(threads.id, threadId));

    const outcomes = await flushMutations(db, account.id, [
      { id: "01UNSNOOZE", intent: { type: "unsnooze", threadId } },
    ]);

    expect(outcomes).toEqual([{ id: "01UNSNOOZE", status: "applied" }]);
    const row = await threadRow(threadId);
    expect(row?.inInbox).toBe(false);
    expect(row?.folderRole).toBe("archive");
  });
});

describe("flushMutations — pin (#43)", () => {
  it("sets and clears pinned, with no protocol write — Pin has no IMAP-side trace (ADR-0006)", async () => {
    const threadId = await seedThread();

    const outcomes = await flushMutations(db, account.id, [
      { id: "01PIN", intent: { type: "setPinned", threadId, pinned: true } },
    ]);

    expect(outcomes).toEqual([{ id: "01PIN", status: "applied" }]);
    expect((await threadRow(threadId))?.pinned).toBe(true);
    expect(await outboxRows(account.id)).toHaveLength(0);

    await flushMutations(db, account.id, [
      { id: "01UNPIN", intent: { type: "setPinned", threadId, pinned: false } },
    ]);
    expect((await threadRow(threadId))?.pinned).toBe(false);
    expect(await outboxRows(account.id)).toHaveLength(0);
  });

  it("rejects a setPinned naming a Thread this Mail Account does not have", async () => {
    const outcomes = await flushMutations(db, account.id, [
      { id: "01MISSING", intent: { type: "setPinned", threadId: "does-not-exist", pinned: true } },
    ]);
    expect(outcomes).toEqual([{ id: "01MISSING", status: "rejected", reason: "thread_not_found" }]);
  });
});

describe("flushMutations — snooze (#76)", () => {
  it("flips inInbox synchronously and sets snoozeUntil, with no protocol write", async () => {
    const threadId = await seedThread();
    const until = new Date(Date.now() + 60_000).toISOString();

    const outcomes = await flushMutations(db, account.id, [
      { id: "01SNOOZE", intent: { type: "snooze", threadId, until } },
    ]);

    expect(outcomes).toEqual([{ id: "01SNOOZE", status: "applied" }]);
    const row = await threadRow(threadId);
    expect(row?.inInbox).toBe(false);
    expect(row?.snoozeUntil?.toISOString()).toBe(until);
    expect(await outboxRows(account.id)).toHaveLength(0);
  });

  it("rejects a snooze naming a Thread this Mail Account does not have", async () => {
    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01MISSING",
        intent: {
          type: "snooze",
          threadId: "does-not-exist",
          until: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    ]);
    expect(outcomes).toEqual([{ id: "01MISSING", status: "rejected", reason: "thread_not_found" }]);
  });

  it("rejects a snooze whose `until` is not strictly in the future", async () => {
    const threadId = await seedThread();

    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01PAST",
        intent: { type: "snooze", threadId, until: new Date(Date.now() - 60_000).toISOString() },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01PAST", status: "rejected", reason: "invalid_snooze_time" }]);
    expect((await threadRow(threadId))?.inInbox).toBe(true);
  });

  it("is idempotent: replaying an already-applied snooze id never re-applies it", async () => {
    const threadId = await seedThread();
    const until = new Date(Date.now() + 60_000).toISOString();

    const first = await flushMutations(db, account.id, [
      { id: "01SNOOZE", intent: { type: "snooze", threadId, until } },
    ]);
    const second = await flushMutations(db, account.id, [
      { id: "01SNOOZE", intent: { type: "snooze", threadId, until } },
    ]);

    expect(first).toEqual([{ id: "01SNOOZE", status: "applied" }]);
    expect(second).toEqual(first);
  });
});

describe("flushMutations — labels (#43, User-scoped since #186)", () => {
  it("creates a Label on first apply and adds it to the Thread, with no protocol write", async () => {
    const threadId = await seedThread();

    const outcomes = await flushMutations(db, account.id, [
      { id: "01APPLY", intent: { type: "applyLabel", threadId, name: "Work" } },
    ]);

    expect(outcomes).toEqual([{ id: "01APPLY", status: "applied" }]);
    const id = labelId(account.userId, "Work");
    expect((await threadRow(threadId))?.labelIds).toEqual([id]);
    const [labelRow] = await db.select().from(labels).where(eq(labels.id, id));
    expect(labelRow).toMatchObject({ userId: account.userId, name: "Work" });
    expect(await outboxRows(account.id)).toHaveLength(0);
  });

  it("finds the existing Label rather than duplicating it when applied a second time", async () => {
    const threadA = await seedThread();
    // `applyLabel` only needs a Thread row to exist, not a Message — a bare
    // `resolveThread` avoids seeding a second "INBOX" folder for the same
    // account (`folders_account_path_key` is unique per account).
    const threadB = await resolveThread(db, {
      mailAccountId: account.id,
      threadingIds: [randomUUID()],
      subject: "Second",
      receivedAt: new Date("2026-01-02T00:00:00Z"),
    });

    await flushMutations(db, account.id, [
      { id: "01A", intent: { type: "applyLabel", threadId: threadA, name: "Work" } },
    ]);
    await flushMutations(db, account.id, [
      { id: "01B", intent: { type: "applyLabel", threadId: threadB, name: "Work" } },
    ]);

    const rows = await db.select().from(labels).where(eq(labels.userId, account.userId));
    expect(rows).toHaveLength(1);
    expect((await threadRow(threadA))?.labelIds).toEqual([labelId(account.userId, "Work")]);
    expect((await threadRow(threadB))?.labelIds).toEqual([labelId(account.userId, "Work")]);
  });

  it("normalizes incidental whitespace so ' Work ' and 'Work' are the same Label", async () => {
    const threadId = await seedThread();

    await flushMutations(db, account.id, [
      { id: "01APPLY", intent: { type: "applyLabel", threadId, name: "  Work  " } },
    ]);

    const rows = await db.select().from(labels).where(eq(labels.userId, account.userId));
    expect(rows.map((row) => row.name)).toEqual(["Work"]);
  });

  it("rejects an empty label name", async () => {
    const threadId = await seedThread();

    const outcomes = await flushMutations(db, account.id, [
      { id: "01EMPTY", intent: { type: "applyLabel", threadId, name: "   " } },
    ]);

    expect(outcomes).toEqual([{ id: "01EMPTY", status: "rejected", reason: "invalid_label_name" }]);
    expect((await threadRow(threadId))?.labelIds).toEqual([]);
  });

  it("removes a Label from a Thread without deleting the Label definition itself", async () => {
    const threadId = await seedThread();
    await flushMutations(db, account.id, [
      { id: "01APPLY", intent: { type: "applyLabel", threadId, name: "Work" } },
    ]);

    const outcomes = await flushMutations(db, account.id, [
      { id: "01REMOVE", intent: { type: "removeLabel", threadId, name: "Work" } },
    ]);

    expect(outcomes).toEqual([{ id: "01REMOVE", status: "applied" }]);
    expect((await threadRow(threadId))?.labelIds).toEqual([]);
    const rows = await db.select().from(labels).where(eq(labels.userId, account.userId));
    expect(rows).toHaveLength(1); // still there — no management UI, no delete route (#43)
  });

  it("is a no-op success removing a Label never applied", async () => {
    const threadId = await seedThread();

    const outcomes = await flushMutations(db, account.id, [
      { id: "01REMOVE", intent: { type: "removeLabel", threadId, name: "Ghost" } },
    ]);

    expect(outcomes).toEqual([{ id: "01REMOVE", status: "applied" }]);
    expect((await threadRow(threadId))?.labelIds).toEqual([]);
  });

  it("spans the User's Mail Accounts — the same name on two of their accounts is one Label (#186)", async () => {
    const sibling = await createTestMailAccount(db, { userId: account.userId });
    const threadHere = await seedThread();
    const threadThere = await resolveThread(db, {
      mailAccountId: sibling.id,
      threadingIds: [randomUUID()],
      subject: "Test",
      receivedAt: new Date("2026-01-01T00:00:00Z"),
    });

    await flushMutations(db, account.id, [
      { id: "01A", intent: { type: "applyLabel", threadId: threadHere, name: "Follow up" } },
    ]);
    await flushMutations(db, sibling.id, [
      { id: "01B", intent: { type: "applyLabel", threadId: threadThere, name: "Follow up" } },
    ]);

    const id = labelId(account.userId, "Follow up");
    const rows = await db.select().from(labels).where(eq(labels.userId, account.userId));
    expect(rows.map((row) => row.id)).toEqual([id]);
    expect((await threadRow(threadHere))?.labelIds).toEqual([id]);
    expect((await threadRow(threadThere))?.labelIds).toEqual([id]);
  });

  it("still scopes a Label to its User — two Users' 'Work' are two Labels (#186)", async () => {
    const strangers = await createTestMailAccount(db);
    const threadHere = await seedThread();

    await flushMutations(db, account.id, [
      { id: "01A", intent: { type: "applyLabel", threadId: threadHere, name: "Work" } },
    ]);
    // No `seedThread` for `strangers` — this asserts the id space, not another apply.
    expect(labelId(account.userId, "Work")).not.toBe(labelId(strangers.userId, "Work"));
    const rows = await db.select().from(labels);
    expect(rows).toHaveLength(1);
  });

  it("rejects an applyLabel naming a Thread this Mail Account does not have", async () => {
    const outcomes = await flushMutations(db, account.id, [
      { id: "01MISSING", intent: { type: "applyLabel", threadId: "does-not-exist", name: "Work" } },
    ]);
    expect(outcomes).toEqual([{ id: "01MISSING", status: "rejected", reason: "thread_not_found" }]);
  });
});

describe("flushMutations — the Gatekeeper decisions (#55)", () => {
  /** Puts one Thread on hold, the way `gatekeeper/screening.ts` would have. */
  async function seedHeldThread(heldSender: string): Promise<string> {
    const threadId = await seedThread();
    await db
      .update(threads)
      .set({ heldSender, heldAt: new Date() })
      .where(eq(threads.id, threadId));
    return threadId;
  }

  it("approves a sender and releases every Thread they were holding", async () => {
    const threadId = await seedHeldThread("stranger@example.test");

    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01APPROVE",
        intent: {
          type: "approveSender",
          sender: { scope: "address", value: "Stranger@Example.test" },
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01APPROVE", status: "applied" }]);
    expect((await threadRow(threadId))?.heldSender).toBeNull();
    expect((await resolveVerdict(db, account.id, "stranger@example.test")).verdict).toBe(
      "approved",
    );
  });

  it("replays a retried decision from the ledger instead of applying it twice", async () => {
    await seedHeldThread("stranger@example.test");
    const intent = {
      type: "blockSender" as const,
      sender: { scope: "address" as const, value: "stranger@example.test" },
    };

    await flushMutations(db, account.id, [{ id: "01BLOCK", intent }]);
    // The sender is now Blocked and nothing is held — a second apply would
    // find no held Threads and quietly do nothing, so the ledger is what
    // actually proves this replayed.
    await flushMutations(db, account.id, [{ id: "01BLOCK", intent }]);

    const ledger = await db
      .select()
      .from(appliedMutations)
      .where(eq(appliedMutations.id, "01BLOCK"));
    expect(ledger).toHaveLength(1);
    expect((await resolveVerdict(db, account.id, "stranger@example.test")).verdict).toBe("blocked");
  });

  it("rejects a domain decision aimed at a public provider, permanently", async () => {
    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01BARRED",
        intent: { type: "blockSender", sender: { scope: "domain", value: "gmail.com" } },
      },
    ]);
    expect(outcomes).toEqual([
      { id: "01BARRED", status: "rejected", reason: "barred_verdict_domain" },
    ]);
  });

  it("spams a sender and records the Verdict with the spam flag (#102)", async () => {
    const threadId = await seedHeldThread("spammer@example.test");

    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01SPAM",
        intent: { type: "spamSender", sender: { scope: "address", value: "spammer@example.test" } },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01SPAM", status: "applied" }]);
    expect((await threadRow(threadId))?.heldSender).toBeNull();
    expect((await resolveVerdict(db, account.id, "spammer@example.test")).verdict).toBe("blocked");
  });

  it("blocks an Alias (#103) — trashes what it's holding and refuses the Mail Account's own address", async () => {
    const threadId = await seedThread();
    await db
      .update(threads)
      .set({
        heldSender: "stranger@example.test",
        heldRecipientAlias: "sales@mycompany.test",
        heldAt: new Date(),
      })
      .where(eq(threads.id, threadId));

    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01ALIAS",
        intent: {
          type: "blockSender",
          sender: { scope: "recipient", value: "sales@mycompany.test" },
        },
      },
      {
        id: "01ALIASOWN",
        intent: {
          type: "blockSender",
          sender: { scope: "recipient", value: account.emailAddress },
        },
      },
    ]);

    expect(outcomes).toEqual([
      { id: "01ALIAS", status: "applied" },
      { id: "01ALIASOWN", status: "rejected", reason: "cannot_block_own_address" },
    ]);
    expect((await threadRow(threadId))?.inInbox).toBe(false);
    expect((await threadRow(threadId))?.heldRecipientAlias).toBeNull();
  });

  it("unblocks back to Unscreened, never to Approved", async () => {
    await flushMutations(db, account.id, [
      {
        id: "01B",
        intent: { type: "blockSender", sender: { scope: "address", value: "v@example.test" } },
      },
      {
        id: "01U",
        intent: { type: "unblockSender", sender: { scope: "address", value: "v@example.test" } },
      },
    ]);
    expect((await resolveVerdict(db, account.id, "v@example.test")).verdict).toBe("unscreened");
  });

  it("unblockAndRestore (#95, ADR-0019) clears a Block and restores the Threads it trashed to Inbox", async () => {
    await seedFolder("trash", "Trash");
    const threadId = await seedHeldThread("stranger@example.test");

    await flushMutations(db, account.id, [
      {
        id: "01BLOCK",
        intent: {
          type: "blockSender",
          sender: { scope: "address", value: "stranger@example.test" },
        },
      },
    ]);
    expect((await threadRow(threadId))?.folderRole).toBe("trash");

    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01UNDO",
        intent: {
          type: "unblockAndRestore",
          sender: { scope: "address", value: "stranger@example.test" },
          threadIds: [threadId],
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01UNDO", status: "applied" }]);
    expect((await resolveVerdict(db, account.id, "stranger@example.test")).verdict).toBe(
      "unscreened",
    );
    const row = await threadRow(threadId);
    expect(row?.inInbox).toBe(true);
    expect(row?.folderRole).toBe("inbox");
    expect(row?.heldSender).toBeNull();
  });

  it("unblockAndRestore restores a Deny's trashed Threads too, with no Verdict to clear", async () => {
    await seedFolder("trash", "Trash");
    const threadId = await seedHeldThread("stranger@example.test");

    await flushMutations(db, account.id, [
      {
        id: "01DENY",
        intent: {
          type: "denySender",
          sender: { scope: "address", value: "stranger@example.test" },
        },
      },
    ]);

    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01UNDO",
        intent: {
          type: "unblockAndRestore",
          sender: { scope: "address", value: "stranger@example.test" },
          threadIds: [threadId],
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01UNDO", status: "applied" }]);
    expect((await resolveVerdict(db, account.id, "stranger@example.test")).verdict).toBe(
      "unscreened",
    );
    expect((await threadRow(threadId))?.inInbox).toBe(true);
  });

  it("unblockAndRestore reverses a spamSender decision, restoring Threads out of Junk (#90's Spam-Undo close-out)", async () => {
    await seedFolder("junk", "Junk");
    const threadId = await seedHeldThread("spammer@example.test");

    await flushMutations(db, account.id, [
      {
        id: "01SPAM",
        intent: { type: "spamSender", sender: { scope: "address", value: "spammer@example.test" } },
      },
    ]);
    expect((await threadRow(threadId))?.folderRole).toBe("junk");

    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01UNDO",
        intent: {
          type: "unblockAndRestore",
          sender: { scope: "address", value: "spammer@example.test" },
          threadIds: [threadId],
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01UNDO", status: "applied" }]);
    expect((await resolveVerdict(db, account.id, "spammer@example.test")).verdict).toBe(
      "unscreened",
    );
    const row = await threadRow(threadId);
    expect(row?.inInbox).toBe(true);
    expect(row?.folderRole).toBe("inbox");
    expect(row?.heldSender).toBeNull();
  });

  it("unblockAndRestore cancels a still-queued trash write instead of letting it drain after the fact (#90)", async () => {
    // No Trash folder seeded on purpose: `blockSender` still records the
    // Verdict and clears the hold, but — per `trashHeldThreads`'s own
    // tolerance for an account with no matching folder — enqueues nothing
    // to move, so nothing IMAP-side is left racing this Undo. The regression
    // this covers is at the outbox layer, so it is asserted directly there
    // instead: a write queued by hand, the way a real `blockSender` flush
    // would have left it mid-drain-window, must be gone afterwards rather
    // than surviving to move the Message once Undo has already said
    // "inbox".
    const threadId = await seedThread();
    const [message] = await db.select().from(messages).where(eq(messages.threadId, threadId));
    if (!message) throw new Error("seedThread did not create a message");

    await db.insert(protocolWrites).values({
      id: "01QUEUED",
      mailAccountId: account.id,
      messageId: message.id,
      kind: "trash",
    });

    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01UNDO",
        intent: {
          type: "unblockAndRestore",
          sender: { scope: "address", value: "irrelevant@example.test" },
          threadIds: [threadId],
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01UNDO", status: "applied" }]);
    const remaining = await db
      .select()
      .from(protocolWrites)
      .where(eq(protocolWrites.mailAccountId, account.id));
    expect(remaining).toEqual([]);
    // The Message never actually moved (no drain ran), so there is nothing
    // to enqueue an "inbox" write for either — the cancellation alone is
    // the whole fix.
  });

  it("unblockAndRestore ignores a threadId belonging to a different Mail Account", async () => {
    await seedFolder("trash", "Trash");
    const threadId = await seedHeldThread("stranger@example.test");
    await flushMutations(db, account.id, [
      {
        id: "01BLOCK",
        intent: {
          type: "blockSender",
          sender: { scope: "address", value: "stranger@example.test" },
        },
      },
    ]);

    const other = await createTestMailAccount(db);
    const outcomes = await flushMutations(db, other.id, [
      {
        id: "01CROSS",
        intent: {
          type: "unblockAndRestore",
          sender: { scope: "address", value: "stranger@example.test" },
          threadIds: [threadId],
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01CROSS", status: "applied" }]); // clears (nothing to clear on `other`) — silently drops the foreign Thread
    expect((await threadRow(threadId))?.folderRole).toBe("trash"); // untouched
  });
});

describe("flushMutations — Spam/Approve/Block on any Inbox Thread (#144)", () => {
  /** An ordinary, never-held Inbox Thread with one Message carrying `fromAddress` — `seedThread` above leaves it unset. */
  async function seedThreadFrom(fromAddress: string): Promise<string> {
    const threadId = await resolveThread(db, {
      mailAccountId: account.id,
      threadingIds: [randomUUID()],
      subject: "Test",
      receivedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const folderId = await seedFolder("inbox", "INBOX");
    await db.insert(messages).values({
      id: randomUUID(),
      mailAccountId: account.id,
      threadId,
      folderId,
      uid: 1,
      subject: "Test",
      fromAddress,
      sentAt: new Date("2026-01-01T00:00:00Z"),
      receivedAt: new Date("2026-01-01T00:00:00Z"),
      seen: false,
    });
    return threadId;
  }

  it("Spam's own `threadId` moves an un-held Inbox Thread to Junk and records the Verdict", async () => {
    await seedFolder("junk", "Junk");
    const threadId = await seedThreadFrom("villain@example.test");

    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01SPAMTHREAD",
        intent: {
          type: "spamSender",
          sender: { scope: "address", value: "villain@example.test" },
          threadId,
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01SPAMTHREAD", status: "applied" }]);
    const row = await threadRow(threadId);
    expect(row?.inInbox).toBe(false);
    expect(row?.folderRole).toBe("junk");
    expect((await resolveVerdict(db, account.id, "villain@example.test")).verdict).toBe("blocked");
  });

  it("Block's own `threadId` moves an un-held Inbox Thread to Trash and records the Verdict", async () => {
    await seedFolder("trash", "Trash");
    const threadId = await seedThreadFrom("stranger@example.test");

    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01BLOCKTHREAD",
        intent: {
          type: "blockSender",
          sender: { scope: "address", value: "stranger@example.test" },
          threadId,
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01BLOCKTHREAD", status: "applied" }]);
    const row = await threadRow(threadId);
    expect(row?.inInbox).toBe(false);
    expect(row?.folderRole).toBe("trash");
    expect((await resolveVerdict(db, account.id, "stranger@example.test")).verdict).toBe("blocked");
  });

  it("Approve's own `threadId` records the Verdict without moving the Thread — it was never held to release", async () => {
    const threadId = await seedThreadFrom("colleague@example.test");

    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01APPROVETHREAD",
        intent: {
          type: "approveSender",
          sender: { scope: "address", value: "colleague@example.test" },
          threadId,
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01APPROVETHREAD", status: "applied" }]);
    const row = await threadRow(threadId);
    expect(row?.inInbox).toBe(true);
    expect(row?.folderRole).toBe("inbox");
    expect((await resolveVerdict(db, account.id, "colleague@example.test")).verdict).toBe(
      "approved",
    );
  });

  it("still succeeds on a Thread this Mail Account genuinely has no matching folder for — the decision is recorded either way", async () => {
    // No Junk folder seeded — mirrors `trashHeldThreads`'s own tolerance
    // (`gatekeeper/decisions.ts`), just reached via a named `threadId`
    // instead of the held-sender match.
    const threadId = await seedThreadFrom("villain@example.test");

    const outcomes = await flushMutations(db, account.id, [
      {
        id: "01SPAMNOFOLDER",
        intent: {
          type: "spamSender",
          sender: { scope: "address", value: "villain@example.test" },
          threadId,
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01SPAMNOFOLDER", status: "applied" }]);
    expect((await resolveVerdict(db, account.id, "villain@example.test")).verdict).toBe("blocked");
  });
});

describe("flushMutations — discardComposition/undiscardComposition (#101)", () => {
  async function insertComposition(status: "draft" | "discarded" | "pending" = "draft") {
    const id = randomUUID();
    await db.insert(compositions).values({
      id,
      mailAccountId: account.id,
      subject: "Subject",
      document: { type: "doc", content: [] },
      version: 1,
      status,
    });
    return id;
  }

  it("dispatches discardComposition to compose/discard.ts, ahead of the Thread lookup", async () => {
    const id = await insertComposition("draft");

    const outcomes = await flushMutations(db, account.id, [
      { id: "01D", intent: { type: "discardComposition", compositionId: id } },
    ]);

    expect(outcomes).toEqual([{ id: "01D", status: "applied" }]);
    const [row] = await db.select().from(compositions).where(eq(compositions.id, id)).limit(1);
    expect(row?.status).toBe("discarded");
  });

  it("rejects discardComposition for a Composition that isn't a Draft", async () => {
    const id = await insertComposition("pending");

    const outcomes = await flushMutations(db, account.id, [
      { id: "01D", intent: { type: "discardComposition", compositionId: id } },
    ]);

    expect(outcomes).toEqual([{ id: "01D", status: "rejected", reason: "not_a_draft" }]);
  });

  it("dispatches undiscardComposition, Undo's real inverse (#95)", async () => {
    const id = await insertComposition("discarded");

    const outcomes = await flushMutations(db, account.id, [
      { id: "01U", intent: { type: "undiscardComposition", compositionId: id } },
    ]);

    expect(outcomes).toEqual([{ id: "01U", status: "applied" }]);
    const [row] = await db.select().from(compositions).where(eq(compositions.id, id)).limit(1);
    expect(row?.status).toBe("draft");
  });
});

/**
 * A Note's structural intents (#192, ADR-0023): `flushUserMutations`'s own
 * dispatch, User-scoped rather than Mail-Account-scoped — `flushMutations`'s
 * `applyLabel`/`removeLabel` describe block above is the closest template,
 * generalized to a queue with no Thread/Mail Account in scope at all.
 */
describe("flushUserMutations — Note structural intents (#192, ADR-0023)", () => {
  async function noteRow(id: string) {
    const [row] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
    return row;
  }

  it("creates a Note with an empty document and no Labels", async () => {
    const noteId = randomUUID();

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01CREATE", intent: { type: "createNote", noteId } },
    ]);

    expect(outcomes).toEqual([{ id: "01CREATE", status: "applied" }]);
    const row = await noteRow(noteId);
    expect(row).toMatchObject({ id: noteId, userId: account.userId, labelIds: [] });
  });

  it("is idempotent: a retried createNote id replays its recorded outcome rather than re-applying", async () => {
    const noteId = randomUUID();
    await flushUserMutations(db, account.userId, [
      { id: "01CREATE", intent: { type: "createNote", noteId } },
    ]);

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01CREATE", intent: { type: "createNote", noteId } },
    ]);

    expect(outcomes).toEqual([{ id: "01CREATE", status: "applied" }]);
    expect(await db.select().from(notes).where(eq(notes.id, noteId))).toHaveLength(1);
  });

  it("deletes a Note permanently and records a tombstone (ADR-0019's real inverse of create)", async () => {
    const noteId = randomUUID();
    await flushUserMutations(db, account.userId, [
      { id: "01CREATE", intent: { type: "createNote", noteId } },
    ]);

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01DELETE", intent: { type: "deleteNote", noteId } },
    ]);

    expect(outcomes).toEqual([{ id: "01DELETE", status: "applied" }]);
    expect(await noteRow(noteId)).toBeUndefined();
    const [tombstone] = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.entityId, noteId));
    expect(tombstone).toMatchObject({ collection: "Note", entityId: noteId, mailAccountId: null });
  });

  it("tolerates deleting a Note that is already gone — the same no-op removeLabel already gives a Thread", async () => {
    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01DELETE", intent: { type: "deleteNote", noteId: randomUUID() } },
    ]);

    expect(outcomes).toEqual([{ id: "01DELETE", status: "applied" }]);
  });

  it("applies a Label to a Note, User-scoped the same way a Thread's applyLabel is", async () => {
    const noteId = randomUUID();
    await flushUserMutations(db, account.userId, [
      { id: "01CREATE", intent: { type: "createNote", noteId } },
    ]);

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01LABEL", intent: { type: "labelNote", noteId, name: "Work" } },
    ]);

    expect(outcomes).toEqual([{ id: "01LABEL", status: "applied" }]);
    const id = labelId(account.userId, "Work");
    expect((await noteRow(noteId))?.labelIds).toEqual([id]);
    expect(await db.select().from(labels).where(eq(labels.id, id))).toHaveLength(1);
  });

  it("shares one Label row between a Note and a Thread of the same User", async () => {
    const threadId = await seedThread();
    const noteId = randomUUID();
    await flushUserMutations(db, account.userId, [
      { id: "01CREATE", intent: { type: "createNote", noteId } },
    ]);
    await flushMutations(db, account.id, [
      { id: "01T", intent: { type: "applyLabel", threadId, name: "Work" } },
    ]);

    await flushUserMutations(db, account.userId, [
      { id: "01N", intent: { type: "labelNote", noteId, name: "Work" } },
    ]);

    const id = labelId(account.userId, "Work");
    expect((await threadRow(threadId))?.labelIds).toEqual([id]);
    expect((await noteRow(noteId))?.labelIds).toEqual([id]);
  });

  it("removes a Label from a Note", async () => {
    const noteId = randomUUID();
    await flushUserMutations(db, account.userId, [
      { id: "01CREATE", intent: { type: "createNote", noteId } },
      { id: "01LABEL", intent: { type: "labelNote", noteId, name: "Work" } },
    ]);

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01UNLABEL", intent: { type: "unlabelNote", noteId, name: "Work" } },
    ]);

    expect(outcomes).toEqual([{ id: "01UNLABEL", status: "applied" }]);
    expect((await noteRow(noteId))?.labelIds).toEqual([]);
  });

  it("rejects labelNote/unlabelNote against a Note this User does not have", async () => {
    const missingId = randomUUID();

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01LABEL", intent: { type: "labelNote", noteId: missingId, name: "Work" } },
    ]);

    expect(outcomes).toEqual([{ id: "01LABEL", status: "rejected", reason: "note_not_found" }]);
  });

  it("rejects an invalid Label name the same way applyLabel does", async () => {
    const noteId = randomUUID();
    await flushUserMutations(db, account.userId, [
      { id: "01CREATE", intent: { type: "createNote", noteId } },
    ]);

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01LABEL", intent: { type: "labelNote", noteId, name: "   " } },
    ]);

    expect(outcomes).toEqual([{ id: "01LABEL", status: "rejected", reason: "invalid_label_name" }]);
  });

  it("pins a Note (#193), the grid's Pinned/Others split", async () => {
    const noteId = randomUUID();
    await flushUserMutations(db, account.userId, [
      { id: "01CREATE", intent: { type: "createNote", noteId } },
    ]);

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01PIN", intent: { type: "pinNote", noteId } },
    ]);

    expect(outcomes).toEqual([{ id: "01PIN", status: "applied" }]);
    expect((await noteRow(noteId))?.pinned).toBe(true);
  });

  it("unpins a Note, the real inverse of pinNote", async () => {
    const noteId = randomUUID();
    await flushUserMutations(db, account.userId, [
      { id: "01CREATE", intent: { type: "createNote", noteId } },
      { id: "01PIN", intent: { type: "pinNote", noteId } },
    ]);

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01UNPIN", intent: { type: "unpinNote", noteId } },
    ]);

    expect(outcomes).toEqual([{ id: "01UNPIN", status: "applied" }]);
    expect((await noteRow(noteId))?.pinned).toBe(false);
  });

  it("rejects pinNote/unpinNote against a Note this User does not have", async () => {
    const missingId = randomUUID();

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01PIN", intent: { type: "pinNote", noteId: missingId } },
    ]);

    expect(outcomes).toEqual([{ id: "01PIN", status: "rejected", reason: "note_not_found" }]);
  });

  describe("trashNote / restoreNote (#194, soft delete and Recently Deleted)", () => {
    it("sets deletedAt rather than removing the row", async () => {
      const noteId = randomUUID();
      await flushUserMutations(db, account.userId, [
        { id: "01CREATE", intent: { type: "createNote", noteId } },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01TRASH", intent: { type: "trashNote", noteId } },
      ]);

      expect(outcomes).toEqual([{ id: "01TRASH", status: "applied" }]);
      const row = await noteRow(noteId);
      expect(row?.deletedAt).not.toBeNull();
    });

    it("restores a Note, the real inverse of trashNote — Labels and pinned untouched", async () => {
      const noteId = randomUUID();
      await flushUserMutations(db, account.userId, [
        { id: "01CREATE", intent: { type: "createNote", noteId } },
        { id: "01LABEL", intent: { type: "labelNote", noteId, name: "Work" } },
        { id: "01PIN", intent: { type: "pinNote", noteId } },
        { id: "01TRASH", intent: { type: "trashNote", noteId } },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01RESTORE", intent: { type: "restoreNote", noteId } },
      ]);

      expect(outcomes).toEqual([{ id: "01RESTORE", status: "applied" }]);
      const row = await noteRow(noteId);
      expect(row?.deletedAt).toBeNull();
      expect(row?.pinned).toBe(true);
      expect(row?.labelIds).toHaveLength(1);
    });

    it("rejects trashNote/restoreNote against a Note this User does not have", async () => {
      const missingId = randomUUID();

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01TRASH", intent: { type: "trashNote", noteId: missingId } },
      ]);

      expect(outcomes).toEqual([{ id: "01TRASH", status: "rejected", reason: "note_not_found" }]);
    });
  });
});

describe("flushUserMutations — Calendar settings (#236)", () => {
  async function insertCalendar(
    overrides: Partial<typeof calendars.$inferInsert> = {},
  ): Promise<string> {
    const id = overrides.id ?? randomUUID();
    await db.insert(calendars).values({
      userId: account.userId,
      name: "Personal",
      description: null,
      timeZone: "UTC",
      originType: "local",
      connectedAccountId: null,
      color: "#4285F4",
      isDefault: false,
      mailAccountId: null,
      mirrored: true,
      capabilities: LOCAL_CALENDAR_CAPABILITIES,
      ...overrides,
      id,
    });
    return id;
  }

  async function calendarRow(id: string) {
    const [row] = await db.select().from(calendars).where(eq(calendars.id, id)).limit(1);
    return row;
  }

  it("updateCalendarDetails applies name/description/timeZone on a writable Calendar", async () => {
    const calendarId = await insertCalendar();

    const outcomes = await flushUserMutations(db, account.userId, [
      {
        id: "01DETAILS",
        intent: {
          type: "updateCalendarDetails",
          calendarId,
          name: "Work",
          description: "Meetings",
          timeZone: "Europe/Amsterdam",
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01DETAILS", status: "applied" }]);
    const row = await calendarRow(calendarId);
    expect(row).toMatchObject({
      name: "Work",
      description: "Meetings",
      timeZone: "Europe/Amsterdam",
    });
  });

  it("rejects updateCalendarDetails against a read-only Calendar", async () => {
    const calendarId = await insertCalendar({
      originType: "connectedAccount",
      connectedAccountId: "acct-1",
      capabilities: { ...LOCAL_CALENDAR_CAPABILITIES, writable: false },
    });

    const outcomes = await flushUserMutations(db, account.userId, [
      {
        id: "01DETAILS",
        intent: {
          type: "updateCalendarDetails",
          calendarId,
          name: "Renamed",
          description: null,
          timeZone: "UTC",
        },
      },
    ]);

    expect(outcomes).toEqual([
      { id: "01DETAILS", status: "rejected", reason: "calendar_not_writable" },
    ]);
    const row = await calendarRow(calendarId);
    expect(row?.name).toBe("Personal");
  });

  it("setCalendarColor applies regardless of writability", async () => {
    const calendarId = await insertCalendar({
      originType: "connectedAccount",
      connectedAccountId: "acct-1",
      capabilities: { ...LOCAL_CALENDAR_CAPABILITIES, writable: false },
    });

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01COLOR", intent: { type: "setCalendarColor", calendarId, color: "#ff0000" } },
    ]);

    expect(outcomes).toEqual([{ id: "01COLOR", status: "applied" }]);
    const row = await calendarRow(calendarId);
    expect(row?.color).toBe("#ff0000");
  });

  it("setDefaultCalendar moves the one true default off every other Calendar this User owns", async () => {
    const first = await insertCalendar({ isDefault: true });
    const second = await insertCalendar({ id: randomUUID(), name: "Other" });

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01DEFAULT", intent: { type: "setDefaultCalendar", calendarId: second } },
    ]);

    expect(outcomes).toEqual([{ id: "01DEFAULT", status: "applied" }]);
    expect((await calendarRow(first))?.isDefault).toBe(false);
    expect((await calendarRow(second))?.isDefault).toBe(true);
  });

  it("setCalendarMailAccount sets a Local Calendar's Mail Account", async () => {
    const calendarId = await insertCalendar();

    const outcomes = await flushUserMutations(db, account.userId, [
      {
        id: "01MAILACCT",
        intent: { type: "setCalendarMailAccount", calendarId, mailAccountId: account.id },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01MAILACCT", status: "applied" }]);
    expect((await calendarRow(calendarId))?.mailAccountId).toBe(account.id);
  });

  it("rejects setCalendarMailAccount against a mirrored Calendar", async () => {
    const calendarId = await insertCalendar({
      originType: "connectedAccount",
      connectedAccountId: "acct-1",
    });

    const outcomes = await flushUserMutations(db, account.userId, [
      {
        id: "01MAILACCT",
        intent: { type: "setCalendarMailAccount", calendarId, mailAccountId: account.id },
      },
    ]);

    expect(outcomes).toEqual([
      { id: "01MAILACCT", status: "rejected", reason: "calendar_not_local" },
    ]);
  });

  it("setCalendarRemindersEnabled applies regardless of writability (#244, ADR-0028)", async () => {
    const calendarId = await insertCalendar({
      originType: "connectedAccount",
      connectedAccountId: "acct-1",
      capabilities: { ...LOCAL_CALENDAR_CAPABILITIES, writable: false },
    });

    const outcomes = await flushUserMutations(db, account.userId, [
      {
        id: "01REMENABLED",
        intent: { type: "setCalendarRemindersEnabled", calendarId, enabled: false },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01REMENABLED", status: "applied" }]);
    const row = await calendarRow(calendarId);
    expect(row?.remindersEnabled).toBe(false);
  });

  it("setCalendarReminderDefault replaces both lists (#244, ADR-0028)", async () => {
    const calendarId = await insertCalendar();

    const outcomes = await flushUserMutations(db, account.userId, [
      {
        id: "01REMDEFAULT",
        intent: {
          type: "setCalendarReminderDefault",
          calendarId,
          reminderDefault: { timed: [30], allDay: [2340] },
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01REMDEFAULT", status: "applied" }]);
    const row = await calendarRow(calendarId);
    expect(row?.reminderDefault).toEqual({ timed: [30], allDay: [2340] });
  });

  /** A Series plus one already-materialised, still-live Occurrence — the minimum a Reminder Due rebuild needs something to build. */
  async function insertSeriesWithOccurrence(calendarId: string): Promise<{ eventId: string }> {
    const seriesId = randomUUID();
    await db.insert(series).values({
      id: seriesId,
      userId: account.userId,
      calendarId,
      uid: `${seriesId}@test`,
      sequence: 0,
      title: "Standup",
      description: null,
      location: null,
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date(Date.now() + 60 * 60 * 1000),
      durationMs: 30 * 60 * 1000,
      rrules: [],
      rdates: [],
      exdates: [],
      transparency: "opaque",
      attendees: [],
      reminders: [],
    });
    const originalStart = new Date(Date.now() + 60 * 60 * 1000);
    const eventId = `${seriesId}@${originalStart.toISOString()}`;
    await db.insert(events).values({
      id: eventId,
      userId: account.userId,
      calendarId,
      seriesId,
      originalStart,
      startAt: originalStart,
      endAt: new Date(originalStart.getTime() + 30 * 60 * 1000),
      allDay: false,
      tzid: "UTC",
      floating: false,
      title: "Standup",
      location: null,
      status: "confirmed",
      transparency: "opaque",
    });
    return { eventId };
  }

  it("setCalendarRemindersEnabled(false) drops every Reminder Due row for the Calendar (#245, ADR-0028)", async () => {
    const calendarId = await insertCalendar({ reminderDefault: { timed: [10], allDay: [] } });
    const { eventId } = await insertSeriesWithOccurrence(calendarId);
    await flushUserMutations(db, account.userId, [
      {
        id: "01SEED",
        intent: {
          type: "setCalendarReminderDefault",
          calendarId,
          reminderDefault: { timed: [10], allDay: [] },
        },
      },
    ]);
    expect(
      await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId)),
    ).not.toHaveLength(0);

    await flushUserMutations(db, account.userId, [
      { id: "01OFF", intent: { type: "setCalendarRemindersEnabled", calendarId, enabled: false } },
    ]);

    expect(
      await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId)),
    ).toHaveLength(0);
  });

  it("setCalendarReminderDefault rebuilds every Series' Reminder Due rows on the Calendar (#245, ADR-0028)", async () => {
    const calendarId = await insertCalendar({ reminderDefault: { timed: [10], allDay: [] } });
    const { eventId } = await insertSeriesWithOccurrence(calendarId);

    const outcomes = await flushUserMutations(db, account.userId, [
      {
        id: "01REMDEFAULT2",
        intent: {
          type: "setCalendarReminderDefault",
          calendarId,
          reminderDefault: { timed: [5, 15], allDay: [] },
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01REMDEFAULT2", status: "applied" }]);
    const rows = await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId));
    expect(rows.map((row) => row.minutesBefore).sort((a, b) => a - b)).toEqual([5, 15]);
  });

  it("rejects every Calendar intent against a Calendar this User does not have", async () => {
    const missingId = randomUUID();

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01COLOR", intent: { type: "setCalendarColor", calendarId: missingId, color: "#fff" } },
    ]);

    expect(outcomes).toEqual([{ id: "01COLOR", status: "rejected", reason: "calendar_not_found" }]);
  });
});

/**
 * `setHomeTimeZone` (#189, widened by #245/ADR-0028): "Changing the Home
 * Time Zone recomputes every all-day and floating `dueAt`" — the
 * `flushUserMutations`-level slice of that; `routes/sync.test.ts`'s own
 * `Preference` suite already covers the column write and its sync-delta
 * round trip.
 */
describe("flushUserMutations — setHomeTimeZone rebuilds Reminder Due (#245, ADR-0028)", () => {
  it("recomputes an all-day Occurrence's dueAt across every Calendar this User owns", async () => {
    const calendarId = randomUUID();
    await db.insert(calendars).values({
      id: calendarId,
      userId: account.userId,
      name: "Personal",
      description: null,
      timeZone: "UTC",
      originType: "local",
      connectedAccountId: null,
      color: "#4285F4",
      isDefault: false,
      mailAccountId: null,
      mirrored: true,
      capabilities: LOCAL_CALENDAR_CAPABILITIES,
      reminderDefault: { timed: [], allDay: [900] },
    });
    const seriesId = randomUUID();
    await db.insert(series).values({
      id: seriesId,
      userId: account.userId,
      calendarId,
      uid: `${seriesId}@test`,
      sequence: 0,
      title: "Conference",
      description: null,
      location: null,
      allDay: true,
      floating: false,
      tzid: null,
      dtstart: new Date(Date.now() + 24 * 60 * 60 * 1000),
      durationMs: 24 * 60 * 60 * 1000,
      rrules: [],
      rdates: [],
      exdates: [],
      transparency: "opaque",
      attendees: [],
      reminders: [],
    });
    const wallClockStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const eventId = `${seriesId}@${wallClockStart.toISOString()}`;
    await db.insert(events).values({
      id: eventId,
      userId: account.userId,
      calendarId,
      seriesId,
      originalStart: wallClockStart,
      startAt: wallClockStart,
      endAt: new Date(wallClockStart.getTime() + 24 * 60 * 60 * 1000),
      allDay: true,
      tzid: null,
      floating: false,
      title: "Conference",
      location: null,
      status: "confirmed",
      transparency: "opaque",
    });
    // Home Time Zone unset yet — nothing can be computed against it.
    expect(
      await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId)),
    ).toHaveLength(0);

    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01TZ", intent: { type: "setHomeTimeZone", homeTimeZone: "Europe/Amsterdam" } },
    ]);

    expect(outcomes).toEqual([{ id: "01TZ", status: "applied" }]);
    const [userRow] = await db.select().from(users).where(eq(users.id, account.userId));
    expect(userRow?.homeTimeZone).toBe("Europe/Amsterdam");
    const rows = await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId));
    expect(rows).not.toHaveLength(0);
  });
});

/** The Snooze toast/Event page's own path (#246, ADR-0028) — `routes/push.ts`'s own test covers the OS notification's direct-POST path onto the same `snoozeReminderDue` call. */
describe("flushUserMutations — snoozeReminder (#246, ADR-0028)", () => {
  async function insertCalendarWithFiredReminder(): Promise<{
    calendarId: string;
    eventId: string;
    firedId: string;
  }> {
    const calendarId = randomUUID();
    await db.insert(calendars).values({
      id: calendarId,
      userId: account.userId,
      name: "Personal",
      description: null,
      timeZone: "UTC",
      originType: "local",
      connectedAccountId: null,
      color: "#4285F4",
      isDefault: false,
      mailAccountId: null,
      mirrored: true,
      capabilities: LOCAL_CALENDAR_CAPABILITIES,
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesId = randomUUID();
    await db.insert(series).values({
      id: seriesId,
      userId: account.userId,
      calendarId,
      uid: `${seriesId}@test`,
      sequence: 0,
      title: "Standup",
      description: null,
      location: null,
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date(Date.now() + 60 * 60 * 1000),
      durationMs: 30 * 60 * 1000,
      rrules: [],
      rdates: [],
      exdates: [],
      transparency: "opaque",
      attendees: [],
      reminders: [],
    });
    const originalStart = new Date(Date.now() + 60 * 60 * 1000);
    const eventId = `${seriesId}@${originalStart.toISOString()}`;
    await db.insert(events).values({
      id: eventId,
      userId: account.userId,
      calendarId,
      seriesId,
      originalStart,
      startAt: originalStart,
      endAt: new Date(originalStart.getTime() + 30 * 60 * 1000),
      allDay: false,
      tzid: "UTC",
      floating: false,
      title: "Standup",
      location: null,
      status: "confirmed",
      transparency: "opaque",
    });
    await flushUserMutations(db, account.userId, [
      {
        id: "01SEEDREM",
        intent: {
          type: "setCalendarReminderDefault",
          calendarId,
          reminderDefault: { timed: [10], allDay: [] },
        },
      },
    ]);
    const firedId = `${eventId}:10`;
    await db
      .update(reminderDue)
      .set({ status: "fired", firedAt: new Date() })
      .where(eq(reminderDue.id, firedId));
    return { calendarId, eventId, firedId };
  }

  it("inserts a one-off pending row and applies", async () => {
    const { eventId, firedId } = await insertCalendarWithFiredReminder();

    const outcomes = await flushUserMutations(db, account.userId, [
      {
        id: "01SNOOZE",
        intent: {
          type: "snoozeReminder",
          reminderDueIds: [firedId],
          snoozeUntil: { kind: "minutes", minutes: 5 },
        },
      },
    ]);

    expect(outcomes).toEqual([{ id: "01SNOOZE", status: "applied" }]);
    const rows = await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId));
    expect(rows.some((row) => row.snoozed && row.status === "pending")).toBe(true);
  });

  it("rejects a Reminder Due id from another User", async () => {
    const { firedId } = await insertCalendarWithFiredReminder();
    const otherAccount = await createTestMailAccount(db);

    const outcomes = await flushUserMutations(db, otherAccount.userId, [
      {
        id: "01SNOOZEOTHER",
        intent: {
          type: "snoozeReminder",
          reminderDueIds: [firedId],
          snoozeUntil: { kind: "minutes", minutes: 5 },
        },
      },
    ]);

    expect(outcomes).toEqual([
      { id: "01SNOOZEOTHER", status: "rejected", reason: "reminder_not_found" },
    ]);
  });

  it("is idempotent: a retried id never snoozes twice", async () => {
    const { eventId, firedId } = await insertCalendarWithFiredReminder();
    const intent = {
      type: "snoozeReminder" as const,
      reminderDueIds: [firedId],
      snoozeUntil: { kind: "minutes" as const, minutes: 5 as const },
    };

    await flushUserMutations(db, account.userId, [{ id: "01SNOOZEONCE", intent }]);
    await flushUserMutations(db, account.userId, [{ id: "01SNOOZEONCE", intent }]);

    const rows = await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId));
    expect(rows.filter((row) => row.snoozed)).toHaveLength(1);
  });
});

describe("flushUserMutations — setAnswerNotificationsEnabled (#243)", () => {
  it("flips the User's own Preference toggle", async () => {
    const outcomes = await flushUserMutations(db, account.userId, [
      { id: "01ANSWERTOGGLE", intent: { type: "setAnswerNotificationsEnabled", enabled: false } },
    ]);

    expect(outcomes).toEqual([{ id: "01ANSWERTOGGLE", status: "applied" }]);
    const [row] = await db.select().from(users).where(eq(users.id, account.userId));
    expect(row?.answerNotificationsEnabled).toBe(false);
  });
});

/**
 * Task and Task List structural intents (#251, ADR-0030): `flushUserMutations`'s
 * own dispatch, the Note describe block above's exact template — same
 * User-scoped queue, same ledger-idempotency, same "real inverse round trip"
 * shape (ADR-0019).
 */
describe("flushUserMutations — Task List and Task structural intents (#251, ADR-0030)", () => {
  async function taskListRow(id: string) {
    const [row] = await db.select().from(taskLists).where(eq(taskLists.id, id)).limit(1);
    return row;
  }

  async function taskRow(id: string) {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return row;
  }

  describe("Task List", () => {
    it("creates a Task List with the Client-given ULID, empty Sections, not the default", async () => {
      const taskListId = randomUUID();

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01CREATE", intent: { type: "createTaskList", taskListId, name: "Errands" } },
      ]);

      expect(outcomes).toEqual([{ id: "01CREATE", status: "applied" }]);
      const row = await taskListRow(taskListId);
      expect(row).toMatchObject({
        id: taskListId,
        userId: account.userId,
        name: "Errands",
        sections: [],
        isDefault: false,
      });
    });

    it("is idempotent: a retried createTaskList id replays its recorded outcome", async () => {
      const taskListId = randomUUID();
      await flushUserMutations(db, account.userId, [
        { id: "01CREATE", intent: { type: "createTaskList", taskListId, name: "Errands" } },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01CREATE", intent: { type: "createTaskList", taskListId, name: "Errands" } },
      ]);

      expect(outcomes).toEqual([{ id: "01CREATE", status: "applied" }]);
      expect(await db.select().from(taskLists).where(eq(taskLists.id, taskListId))).toHaveLength(1);
    });

    it("renames a Task List", async () => {
      const taskListId = randomUUID();
      await flushUserMutations(db, account.userId, [
        { id: "01CREATE", intent: { type: "createTaskList", taskListId, name: "Errands" } },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01RENAME", intent: { type: "renameTaskList", taskListId, name: "Chores" } },
      ]);

      expect(outcomes).toEqual([{ id: "01RENAME", status: "applied" }]);
      expect((await taskListRow(taskListId))?.name).toBe("Chores");
    });

    it("reorders a Task List", async () => {
      const taskListId = randomUUID();
      await flushUserMutations(db, account.userId, [
        { id: "01CREATE", intent: { type: "createTaskList", taskListId, name: "Errands" } },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01REORDER", intent: { type: "reorderTaskList", taskListId, order: 4 } },
      ]);

      expect(outcomes).toEqual([{ id: "01REORDER", status: "applied" }]);
      expect((await taskListRow(taskListId))?.order).toBe(4);
    });

    it("deletes a Task List, cascading a soft delete onto the Client-captured Tasks it took", async () => {
      const taskListId = randomUUID();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        { id: "01LIST", intent: { type: "createTaskList", taskListId, name: "Errands" } },
        {
          id: "01TASK",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01DELETE", intent: { type: "deleteTaskList", taskListId, taskIds: [taskId] } },
      ]);

      expect(outcomes).toEqual([{ id: "01DELETE", status: "applied" }]);
      expect((await taskListRow(taskListId))?.deletedAt).not.toBeNull();
      expect((await taskRow(taskId))?.deletedAt).not.toBeNull();
    });

    it("restores a Task List, the real inverse of deleteTaskList — List and every Task it took come back", async () => {
      const taskListId = randomUUID();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        { id: "01LIST", intent: { type: "createTaskList", taskListId, name: "Errands" } },
        {
          id: "01TASK",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
        { id: "01DELETE", intent: { type: "deleteTaskList", taskListId, taskIds: [taskId] } },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01RESTORE", intent: { type: "restoreTaskList", taskListId, taskIds: [taskId] } },
      ]);

      expect(outcomes).toEqual([{ id: "01RESTORE", status: "applied" }]);
      expect((await taskListRow(taskListId))?.deletedAt).toBeNull();
      expect((await taskRow(taskId))?.deletedAt).toBeNull();
    });

    it("never deletes the seeded default List — a property of isDefault, not the name", async () => {
      const defaultId = `${account.userId}:default`;
      await db.insert(taskLists).values({
        id: defaultId,
        userId: account.userId,
        name: "Tasks",
        isDefault: true,
      });
      // Renaming it away from "Tasks" must not open the delete back up.
      await flushUserMutations(db, account.userId, [
        {
          id: "01RENAME",
          intent: { type: "renameTaskList", taskListId: defaultId, name: "Errands" },
        },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01DELETE", intent: { type: "deleteTaskList", taskListId: defaultId, taskIds: [] } },
      ]);

      expect(outcomes).toEqual([{ id: "01DELETE", status: "rejected", reason: "default_list" }]);
      expect((await taskListRow(defaultId))?.deletedAt).toBeNull();
    });
  });

  describe("Section", () => {
    async function createList(): Promise<string> {
      const taskListId = randomUUID();
      await flushUserMutations(db, account.userId, [
        { id: randomUUID(), intent: { type: "createTaskList", taskListId, name: "Errands" } },
      ]);
      return taskListId;
    }

    it("creates a Section, appended to the List's ordered array", async () => {
      const taskListId = await createList();
      const sectionId = randomUUID();

      const outcomes = await flushUserMutations(db, account.userId, [
        {
          id: "01SECTION",
          intent: { type: "createSection", taskListId, sectionId, name: "Today" },
        },
      ]);

      expect(outcomes).toEqual([{ id: "01SECTION", status: "applied" }]);
      expect((await taskListRow(taskListId))?.sections).toEqual([{ id: sectionId, name: "Today" }]);
    });

    it("renames a Section in place", async () => {
      const taskListId = await createList();
      const sectionId = randomUUID();
      await flushUserMutations(db, account.userId, [
        {
          id: "01SECTION",
          intent: { type: "createSection", taskListId, sectionId, name: "Today" },
        },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        {
          id: "01RENAME",
          intent: { type: "renameSection", taskListId, sectionId, name: "This week" },
        },
      ]);

      expect(outcomes).toEqual([{ id: "01RENAME", status: "applied" }]);
      expect((await taskListRow(taskListId))?.sections).toEqual([
        { id: sectionId, name: "This week" },
      ]);
    });

    it("reorders Sections to the Client's given order", async () => {
      const taskListId = await createList();
      const a = randomUUID();
      const b = randomUUID();
      await flushUserMutations(db, account.userId, [
        { id: "01A", intent: { type: "createSection", taskListId, sectionId: a, name: "A" } },
        { id: "01B", intent: { type: "createSection", taskListId, sectionId: b, name: "B" } },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        {
          id: "01REORDER",
          intent: { type: "reorderSections", taskListId, sectionIds: [b, a] },
        },
      ]);

      expect(outcomes).toEqual([{ id: "01REORDER", status: "applied" }]);
      expect((await taskListRow(taskListId))?.sections.map((section) => section.id)).toEqual([
        b,
        a,
      ]);
    });

    it("deletes a Section, moving its Tasks to the List's first remaining Section in the same intent", async () => {
      const taskListId = await createList();
      const first = randomUUID();
      const second = randomUUID();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        { id: "01A", intent: { type: "createSection", taskListId, sectionId: first, name: "A" } },
        { id: "01B", intent: { type: "createSection", taskListId, sectionId: second, name: "B" } },
        {
          id: "01TASK",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: second,
            title: "Buy milk",
            order: 0,
          },
        },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        {
          id: "01DELETE",
          intent: { type: "deleteSection", taskListId, sectionId: second, taskIds: [taskId] },
        },
      ]);

      expect(outcomes).toEqual([{ id: "01DELETE", status: "applied" }]);
      expect((await taskListRow(taskListId))?.sections).toEqual([{ id: first, name: "A" }]);
      expect((await taskRow(taskId))?.sectionId).toBe(first);
    });

    it("restores a Section, the real inverse of deleteSection — Section and its Tasks return", async () => {
      const taskListId = await createList();
      const first = randomUUID();
      const second = randomUUID();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        { id: "01A", intent: { type: "createSection", taskListId, sectionId: first, name: "A" } },
        { id: "01B", intent: { type: "createSection", taskListId, sectionId: second, name: "B" } },
        {
          id: "01TASK",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: second,
            title: "Buy milk",
            order: 0,
          },
        },
        {
          id: "01DELETE",
          intent: { type: "deleteSection", taskListId, sectionId: second, taskIds: [taskId] },
        },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        {
          id: "01RESTORE",
          intent: {
            type: "restoreSection",
            taskListId,
            sectionId: second,
            name: "B",
            index: 1,
            taskIds: [taskId],
          },
        },
      ]);

      expect(outcomes).toEqual([{ id: "01RESTORE", status: "applied" }]);
      expect((await taskListRow(taskListId))?.sections).toEqual([
        { id: first, name: "A" },
        { id: second, name: "B" },
      ]);
      expect((await taskRow(taskId))?.sectionId).toBe(second);
    });
  });

  describe("Task", () => {
    async function createList(): Promise<string> {
      const taskListId = randomUUID();
      await flushUserMutations(db, account.userId, [
        { id: randomUUID(), intent: { type: "createTaskList", taskListId, name: "Errands" } },
      ]);
      return taskListId;
    }

    it("creates a Task with the Client-given ULID, unsectioned, incomplete", async () => {
      const taskListId = await createList();
      const taskId = randomUUID();

      const outcomes = await flushUserMutations(db, account.userId, [
        {
          id: "01CREATE",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 1,
          },
        },
      ]);

      expect(outcomes).toEqual([{ id: "01CREATE", status: "applied" }]);
      const row = await taskRow(taskId);
      expect(row).toMatchObject({
        id: taskId,
        userId: account.userId,
        taskListId,
        sectionId: null,
        title: "Buy milk",
        completed: false,
        order: 1,
      });
    });

    it("rejects createTask against a Task List this User does not have", async () => {
      const taskId = randomUUID();

      const outcomes = await flushUserMutations(db, account.userId, [
        {
          id: "01CREATE",
          intent: {
            type: "createTask",
            taskId,
            taskListId: randomUUID(),
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
      ]);

      expect(outcomes).toEqual([
        { id: "01CREATE", status: "rejected", reason: "task_list_not_found" },
      ]);
    });

    it("deletes a Task permanently and records a tombstone — the real inverse of createTask", async () => {
      const taskListId = await createList();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        {
          id: "01CREATE",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01DELETE", intent: { type: "deleteTask", taskId } },
      ]);

      expect(outcomes).toEqual([{ id: "01DELETE", status: "applied" }]);
      expect(await taskRow(taskId)).toBeUndefined();
      const [tombstone] = await db
        .select()
        .from(syncTombstones)
        .where(eq(syncTombstones.entityId, taskId));
      expect(tombstone).toMatchObject({
        collection: "Task",
        entityId: taskId,
        mailAccountId: null,
      });
    });

    it("patches title and due date, each its own field", async () => {
      const taskListId = await createList();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        {
          id: "01CREATE",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01TITLE", intent: { type: "setTaskTitle", taskId, title: "Buy oat milk" } },
        {
          id: "01DUE",
          intent: { type: "setTaskDueDate", taskId, dueDate: "2026-06-01T08:00:00.000Z" },
        },
      ]);

      expect(outcomes).toEqual([
        { id: "01TITLE", status: "applied" },
        { id: "01DUE", status: "applied" },
      ]);
      const row = await taskRow(taskId);
      expect(row?.title).toBe("Buy oat milk");
      expect(row?.dueDate?.toISOString()).toBe("2026-06-01T08:00:00.000Z");
    });

    it("completes and uncompletes a Task, a genuine inverse pair", async () => {
      const taskListId = await createList();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        {
          id: "01CREATE",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
      ]);

      await flushUserMutations(db, account.userId, [
        { id: "01COMPLETE", intent: { type: "completeTask", taskId } },
      ]);
      let row = await taskRow(taskId);
      expect(row?.completed).toBe(true);
      expect(row?.completedAt).not.toBeNull();

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01UNCOMPLETE", intent: { type: "uncompleteTask", taskId } },
      ]);
      expect(outcomes).toEqual([{ id: "01UNCOMPLETE", status: "applied" }]);
      row = await taskRow(taskId);
      expect(row?.completed).toBe(false);
      expect(row?.completedAt).toBeNull();
    });

    it("moves a Task to a different Section within its List", async () => {
      const taskListId = await createList();
      const sectionId = randomUUID();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        {
          id: "01SECTION",
          intent: { type: "createSection", taskListId, sectionId, name: "Today" },
        },
        {
          id: "01CREATE",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01MOVE", intent: { type: "setTaskSection", taskId, sectionId } },
      ]);

      expect(outcomes).toEqual([{ id: "01MOVE", status: "applied" }]);
      expect((await taskRow(taskId))?.sectionId).toBe(sectionId);
    });

    it("moves a Task to a different List", async () => {
      const taskListId = await createList();
      const destinationId = await createList();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        {
          id: "01CREATE",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        {
          id: "01MOVE",
          intent: { type: "setTaskList", taskId, taskListId: destinationId, sectionId: null },
        },
      ]);

      expect(outcomes).toEqual([{ id: "01MOVE", status: "applied" }]);
      expect((await taskRow(taskId))?.taskListId).toBe(destinationId);
    });

    it("reorders a Task", async () => {
      const taskListId = await createList();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        {
          id: "01CREATE",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01REORDER", intent: { type: "reorderTask", taskId, order: 2.5 } },
      ]);

      expect(outcomes).toEqual([{ id: "01REORDER", status: "applied" }]);
      expect((await taskRow(taskId))?.order).toBe(2.5);
    });

    it("trashes and restores a Task, a genuine inverse pair distinct from deleteTask", async () => {
      const taskListId = await createList();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        {
          id: "01CREATE",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
      ]);

      await flushUserMutations(db, account.userId, [
        { id: "01TRASH", intent: { type: "trashTask", taskId } },
      ]);
      expect((await taskRow(taskId))?.deletedAt).not.toBeNull();

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01RESTORE", intent: { type: "restoreTask", taskId } },
      ]);
      expect(outcomes).toEqual([{ id: "01RESTORE", status: "applied" }]);
      expect((await taskRow(taskId))?.deletedAt).toBeNull();
    });

    it("rejects field/lifecycle intents against a Task this User does not have", async () => {
      const missingId = randomUUID();

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01TITLE", intent: { type: "setTaskTitle", taskId: missingId, title: "x" } },
      ]);

      expect(outcomes).toEqual([{ id: "01TITLE", status: "rejected", reason: "task_not_found" }]);
    });

    it("patches a floating due time, independent of setTaskDueDate", async () => {
      const taskListId = await createList();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        {
          id: "01CREATE",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        {
          id: "01DUE",
          intent: { type: "setTaskDueDate", taskId, dueDate: "2026-06-01T00:00:00.000Z" },
        },
        { id: "01TIME", intent: { type: "setTaskDueTime", taskId, dueTime: "14:30" } },
      ]);

      expect(outcomes).toEqual([
        { id: "01DUE", status: "applied" },
        { id: "01TIME", status: "applied" },
      ]);
      expect((await taskRow(taskId))?.dueTime).toBe("14:30");
    });

    it("applies a Label to a Task, User-scoped the same way labelNote is", async () => {
      const taskListId = await createList();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        {
          id: "01CREATE",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01LABEL", intent: { type: "labelTask", taskId, name: "Work" } },
      ]);

      expect(outcomes).toEqual([{ id: "01LABEL", status: "applied" }]);
      const id = labelId(account.userId, "Work");
      expect((await taskRow(taskId))?.labelIds).toEqual([id]);
      expect(await db.select().from(labels).where(eq(labels.id, id))).toHaveLength(1);
    });

    it("removes a Label from a Task", async () => {
      const taskListId = await createList();
      const taskId = randomUUID();
      await flushUserMutations(db, account.userId, [
        {
          id: "01CREATE",
          intent: {
            type: "createTask",
            taskId,
            taskListId,
            sectionId: null,
            title: "Buy milk",
            order: 0,
          },
        },
        { id: "01LABEL", intent: { type: "labelTask", taskId, name: "Work" } },
      ]);

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01UNLABEL", intent: { type: "unlabelTask", taskId, name: "Work" } },
      ]);

      expect(outcomes).toEqual([{ id: "01UNLABEL", status: "applied" }]);
      expect((await taskRow(taskId))?.labelIds).toEqual([]);
    });

    it("rejects labelTask/unlabelTask against a Task this User does not have", async () => {
      const missingId = randomUUID();

      const outcomes = await flushUserMutations(db, account.userId, [
        { id: "01LABEL", intent: { type: "labelTask", taskId: missingId, name: "Work" } },
      ]);

      expect(outcomes).toEqual([{ id: "01LABEL", status: "rejected", reason: "task_not_found" }]);
    });
  });
});
