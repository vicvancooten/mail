import { randomUUID } from "node:crypto";
import { EMPTY_NOTE_DOCUMENT } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { notes, syncTombstones, taskLists, tasks } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { purgeExpiredTombstones } from "./trash-purge.js";

/**
 * `sync/trash-purge.ts`'s sweep (#194, generalised by #257) against a real
 * Postgres — the interesting properties (the 30-day boundary, the
 * tombstone this leaves for every Client's next `POST /sync` to read, and
 * the Task List → Task cascade) only exist at the database boundary, the
 * same reasoning `snooze.test.ts` gives its own sweep. `Note` coverage below
 * is `note-purge.test.ts`'s own suite, carried over verbatim against the
 * generalised entry point; `TaskList`/`Task` coverage (including the
 * cascade) is this ticket's own addition.
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

async function seedNote(deletedAt: Date | null): Promise<string> {
  const id = randomUUID();
  await db.insert(notes).values({
    id,
    userId: account.userId,
    document: EMPTY_NOTE_DOCUMENT,
    labelIds: [],
    deletedAt,
  });
  return id;
}

async function seedTaskList(deletedAt: Date | null): Promise<string> {
  const id = randomUUID();
  await db.insert(taskLists).values({ id, userId: account.userId, name: "List", deletedAt });
  return id;
}

async function seedTask(taskListId: string, deletedAt: Date | null): Promise<string> {
  const id = randomUUID();
  await db.insert(tasks).values({
    id,
    userId: account.userId,
    taskListId,
    title: "Task",
    document: EMPTY_NOTE_DOCUMENT,
    deletedAt,
  });
  return id;
}

describe("purgeExpiredTombstones — Note (#194)", () => {
  it("purges a Note whose deletedAt is past the 30-day retention window", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const noteId = await seedNote(new Date("2026-05-31T00:00:00Z"));

    const purged = await purgeExpiredTombstones(db, now);

    expect(purged).toBe(1);
    const [row] = await db.select().from(notes).where(eq(notes.id, noteId));
    expect(row).toBeUndefined();
  });

  it("records a tombstone for every purged Note — the ordinary destroyed-entity path", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const noteId = await seedNote(new Date("2026-05-31T00:00:00Z"));

    await purgeExpiredTombstones(db, now);

    const [tombstone] = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.entityId, noteId));
    expect(tombstone?.collection).toBe("Note");
    expect(tombstone?.mailAccountId).toBeNull();
  });

  it("leaves a Note still inside its 30-day window untouched", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const noteId = await seedNote(new Date("2026-06-01T00:00:01Z"));

    const purged = await purgeExpiredTombstones(db, now);

    expect(purged).toBe(0);
    const [row] = await db.select().from(notes).where(eq(notes.id, noteId));
    expect(row).toBeDefined();
  });

  it("leaves an ordinary, never-deleted Note untouched", async () => {
    const noteId = await seedNote(null);

    const purged = await purgeExpiredTombstones(db, new Date("2026-12-31T00:00:00Z"));

    expect(purged).toBe(0);
    const [row] = await db.select().from(notes).where(eq(notes.id, noteId));
    expect(row).toBeDefined();
  });

  it("purges exactly at the 30-day boundary (<=, not <)", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const atBoundary = await seedNote(new Date("2026-05-31T00:00:00Z"));

    const purged = await purgeExpiredTombstones(db, now);

    expect(purged).toBe(1);
    const [row] = await db.select().from(notes).where(eq(notes.id, atBoundary));
    expect(row).toBeUndefined();
  });
});

describe("purgeExpiredTombstones — Task List and Task (#257)", () => {
  it("purges an expired Task List and records its own tombstone", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const listId = await seedTaskList(new Date("2026-05-31T00:00:00Z"));

    const purged = await purgeExpiredTombstones(db, now);

    expect(purged).toBe(1);
    const [row] = await db.select().from(taskLists).where(eq(taskLists.id, listId));
    expect(row).toBeUndefined();
    const [tombstone] = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.entityId, listId));
    expect(tombstone?.collection).toBe("TaskList");
  });

  it("purges an expired Task independently of its (still-live) List", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const listId = await seedTaskList(null);
    const taskId = await seedTask(listId, new Date("2026-05-31T00:00:00Z"));

    const purged = await purgeExpiredTombstones(db, now);

    expect(purged).toBe(1);
    const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(taskRow).toBeUndefined();
    const [listRow] = await db.select().from(taskLists).where(eq(taskLists.id, listId));
    expect(listRow).toBeDefined();
  });

  it("leaves an ordinary, never-deleted Task List and Task untouched", async () => {
    const listId = await seedTaskList(null);
    const taskId = await seedTask(listId, null);

    const purged = await purgeExpiredTombstones(db, new Date("2026-12-31T00:00:00Z"));

    expect(purged).toBe(0);
    expect((await db.select().from(taskLists).where(eq(taskLists.id, listId)))[0]).toBeDefined();
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]).toBeDefined();
  });

  it("purges a List and its own cascaded Tasks in the same sweep, each with its own tombstone", async () => {
    // `deleteTaskList` (`sync/mutations.ts`) stamps the same `deletedAt` on
    // the List and every Task it takes — this is that shape, at the purge
    // boundary: both are exactly 30 days past the same moment.
    const now = new Date("2026-06-30T00:00:00Z");
    const deletedAt = new Date("2026-05-31T00:00:00Z");
    const listId = await seedTaskList(deletedAt);
    const taskAId = await seedTask(listId, deletedAt);
    const taskBId = await seedTask(listId, deletedAt);

    const purged = await purgeExpiredTombstones(db, now);

    // The List's own row plus both Tasks — even though Postgres's own
    // `ON DELETE CASCADE` (`db/schema.ts#tasks`) may have already removed
    // the Task rows as a side effect of the List's delete, depending on
    // which collection's turn came first in the sweep.
    expect(purged).toBe(3);
    expect((await db.select().from(taskLists).where(eq(taskLists.id, listId)))[0]).toBeUndefined();
    expect((await db.select().from(tasks).where(eq(tasks.id, taskAId)))[0]).toBeUndefined();
    expect((await db.select().from(tasks).where(eq(tasks.id, taskBId)))[0]).toBeUndefined();

    const tombstoneIds = (
      await db
        .select({ entityId: syncTombstones.entityId, collection: syncTombstones.collection })
        .from(syncTombstones)
    ).map((row) => `${row.collection}:${row.entityId}`);
    expect(tombstoneIds).toEqual(
      expect.arrayContaining([`TaskList:${listId}`, `Task:${taskAId}`, `Task:${taskBId}`]),
    );
  });

  it("purges exactly at the 30-day boundary for a Task (<=, not <)", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const listId = await seedTaskList(null);
    const taskId = await seedTask(listId, new Date("2026-05-31T00:00:00Z"));

    const purged = await purgeExpiredTombstones(db, now);

    expect(purged).toBe(1);
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]).toBeUndefined();
  });
});
