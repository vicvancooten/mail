import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { appliedMutations, folders, messages, protocolWrites, threads } from "../db/schema.js";
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
});
