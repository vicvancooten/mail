import { randomUUID } from "node:crypto";
import { labelId } from "@mail/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  appliedMutations,
  folders,
  labels,
  messages,
  protocolWrites,
  threads,
} from "../db/schema.js";
import { resolveVerdict } from "../gatekeeper/verdicts.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { flushMutations } from "./mutations.js";
import { resolveThread } from "./threading.js";

/**
 * `sync/mutations.ts` against a real Postgres — the idempotency ledger and
 * `\Seen`/`\Flagged` writes are statements, not pure functions, and the
 * interesting property (a retried id never re-applies) only exists at the
 * database boundary.
 */
let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;

beforeEach(async () => {
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
  role: "inbox" | "archive" | "trash" | "sent",
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

describe("flushMutations — labels (#43)", () => {
  it("creates a Label on first apply and adds it to the Thread, with no protocol write", async () => {
    const threadId = await seedThread();

    const outcomes = await flushMutations(db, account.id, [
      { id: "01APPLY", intent: { type: "applyLabel", threadId, name: "Work" } },
    ]);

    expect(outcomes).toEqual([{ id: "01APPLY", status: "applied" }]);
    const id = labelId(account.id, "Work");
    expect((await threadRow(threadId))?.labelIds).toEqual([id]);
    const [labelRow] = await db.select().from(labels).where(eq(labels.id, id));
    expect(labelRow).toMatchObject({ mailAccountId: account.id, name: "Work" });
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

    const rows = await db.select().from(labels).where(eq(labels.mailAccountId, account.id));
    expect(rows).toHaveLength(1);
    expect((await threadRow(threadA))?.labelIds).toEqual([labelId(account.id, "Work")]);
    expect((await threadRow(threadB))?.labelIds).toEqual([labelId(account.id, "Work")]);
  });

  it("normalizes incidental whitespace so ' Work ' and 'Work' are the same Label", async () => {
    const threadId = await seedThread();

    await flushMutations(db, account.id, [
      { id: "01APPLY", intent: { type: "applyLabel", threadId, name: "  Work  " } },
    ]);

    const rows = await db.select().from(labels).where(eq(labels.mailAccountId, account.id));
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
    const rows = await db.select().from(labels).where(eq(labels.mailAccountId, account.id));
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

  it("scopes a Label to its Mail Account — the same name on two accounts is two Labels", async () => {
    const other = await createTestMailAccount(db);
    const threadHere = await seedThread();

    await flushMutations(db, account.id, [
      { id: "01A", intent: { type: "applyLabel", threadId: threadHere, name: "Work" } },
    ]);
    // No `seedThread` for `other` — this asserts the id space, not another apply.
    expect(labelId(account.id, "Work")).not.toBe(labelId(other.id, "Work"));
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
