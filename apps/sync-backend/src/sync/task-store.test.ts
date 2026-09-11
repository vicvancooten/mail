import { randomUUID } from "node:crypto";
import type { NoteDocument } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { taskLists, tasks } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { flushTaskSaves, INITIAL_TASK_DOCUMENT } from "./task-store.js";

/**
 * `flushTaskSaves` (#251, #250): the `documentSaves` channel's `Task` entry
 * — `note-store.test.ts`'s own shape, except for the one place a Task's own
 * doc comment says it differs (`task-store.ts`'s own doc comment): a save
 * against a Task row that doesn't exist yet is dropped, never lazily
 * created, since a save alone carries none of `taskListId`/`title`.
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

async function createTaskList(): Promise<string> {
  const taskListId = randomUUID();
  await db.insert(taskLists).values({ id: taskListId, userId: account.userId, name: "Errands" });
  return taskListId;
}

async function createTask(taskListId: string): Promise<string> {
  const taskId = randomUUID();
  await db.insert(tasks).values({
    id: taskId,
    userId: account.userId,
    taskListId,
    title: "Buy milk",
    document: INITIAL_TASK_DOCUMENT,
  });
  return taskId;
}

describe("flushTaskSaves", () => {
  it("writes a Task's document and reports it applied", async () => {
    const taskListId = await createTaskList();
    const taskId = await createTask(taskListId);
    const document: NoteDocument = [
      { id: "b1", type: "paragraph", props: {}, content: [], children: [] },
    ];

    const outcomes = await flushTaskSaves(db, account.userId, [
      { collection: "Task", id: taskId, saveId: "01SAVE", document },
    ]);

    expect(outcomes).toEqual([
      { collection: "Task", id: taskId, saveId: "01SAVE", status: "applied" },
    ]);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row?.document).toEqual(document);
  });

  it("drops a save that raced a not-yet-applied createTask, still reporting it applied", async () => {
    const missingId = randomUUID();
    const document: NoteDocument = [];

    const outcomes = await flushTaskSaves(db, account.userId, [
      { collection: "Task", id: missingId, saveId: "01SAVE", document },
    ]);

    expect(outcomes).toEqual([
      { collection: "Task", id: missingId, saveId: "01SAVE", status: "applied" },
    ]);
    expect(await db.select().from(tasks).where(eq(tasks.id, missingId))).toHaveLength(0);
  });

  it("leaves another User's Task untouched", async () => {
    const other = await createTestMailAccount(db);
    const otherListId = randomUUID();
    await db.insert(taskLists).values({ id: otherListId, userId: other.userId, name: "Errands" });
    const taskId = randomUUID();
    await db.insert(tasks).values({
      id: taskId,
      userId: other.userId,
      taskListId: otherListId,
      title: "Not yours",
      document: INITIAL_TASK_DOCUMENT,
    });

    await flushTaskSaves(db, account.userId, [
      { collection: "Task", id: taskId, saveId: "01SAVE", document: [] },
    ]);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row?.document).toEqual(INITIAL_TASK_DOCUMENT);
  });
});
