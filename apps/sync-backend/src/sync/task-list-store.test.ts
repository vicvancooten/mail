import { defaultTaskListId } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { taskLists } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { ensureDefaultTaskList } from "./task-list-store.js";

/**
 * `ensureDefaultTaskList` (#251): seeded server-side on a User's first sync
 * of the `TaskList` collection, named "Tasks", never duplicated by a second
 * device racing the first sync — the ticket's own acceptance line.
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

describe("ensureDefaultTaskList", () => {
  it("seeds exactly one List named 'Tasks', flagged isDefault", async () => {
    await ensureDefaultTaskList(db, account.userId);

    const rows = await db.select().from(taskLists).where(eq(taskLists.userId, account.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: defaultTaskListId(account.userId),
      name: "Tasks",
      sections: [],
      isDefault: true,
    });
  });

  it("is a no-op once the default already exists", async () => {
    await ensureDefaultTaskList(db, account.userId);
    await ensureDefaultTaskList(db, account.userId);

    const rows = await db.select().from(taskLists).where(eq(taskLists.userId, account.userId));
    expect(rows).toHaveLength(1);
  });

  it("never mints a second default for two devices racing this User's first sync", async () => {
    // Two "devices" calling concurrently — the deterministic id plus
    // `onConflictDoNothing` (`task-list-store.ts`'s own doc comment) is what
    // keeps this to exactly one row rather than a race on the existence
    // check above.
    await Promise.all([
      ensureDefaultTaskList(db, account.userId),
      ensureDefaultTaskList(db, account.userId),
    ]);

    const rows = await db.select().from(taskLists).where(eq(taskLists.userId, account.userId));
    expect(rows).toHaveLength(1);
  });

  it("never seeds a second User's default off the first User's call", async () => {
    const other = await createTestMailAccount(db);

    await ensureDefaultTaskList(db, account.userId);

    const otherRows = await db.select().from(taskLists).where(eq(taskLists.userId, other.userId));
    expect(otherRows).toHaveLength(0);
  });
});
