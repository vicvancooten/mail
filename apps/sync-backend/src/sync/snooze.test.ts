import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { threads } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { wakeDueSnoozes } from "./snooze.js";
import { resolveThread } from "./threading.js";

/**
 * `sync/snooze.ts`'s wake sweep (#76) against a real Postgres — the
 * interesting property (a due-but-not-yet-woken row is untouched, a woken
 * row's `sync_rev` bump is what lets it ride the ordinary Thread delta) only
 * exists at the database boundary, same reasoning `mutations.test.ts` gives.
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

/** A bare Thread row, snoozed until `snoozeUntil` (or not snoozed at all if `null`) — no Message needed, the sweep only ever reads `threads`. */
async function seedSnoozedThread(snoozeUntil: Date | null): Promise<string> {
  const threadId = await resolveThread(db, {
    mailAccountId: account.id,
    threadingIds: [randomUUID()],
    subject: "Test",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
  });
  await db
    .update(threads)
    .set({ inInbox: snoozeUntil === null, snoozeUntil })
    .where(eq(threads.id, threadId));
  return threadId;
}

async function threadRow(threadId: string) {
  const [row] = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
  return row;
}

describe("wakeDueSnoozes", () => {
  it("wakes a Thread whose snoozeUntil has passed: clears snoozeUntil and returns it to the Inbox", async () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const threadId = await seedSnoozedThread(new Date("2026-06-01T11:59:59Z"));

    const woken = await wakeDueSnoozes(db, now);

    expect(woken).toBe(1);
    const row = await threadRow(threadId);
    expect(row?.snoozeUntil).toBeNull();
    expect(row?.inInbox).toBe(true);
  });

  it("leaves a Thread whose snoozeUntil is still in the future untouched", async () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const threadId = await seedSnoozedThread(new Date("2026-06-01T12:00:01Z"));

    const woken = await wakeDueSnoozes(db, now);

    expect(woken).toBe(0);
    const row = await threadRow(threadId);
    expect(row?.snoozeUntil).not.toBeNull();
    expect(row?.inInbox).toBe(false);
  });

  it("leaves an un-snoozed Thread untouched", async () => {
    const threadId = await seedSnoozedThread(null);

    const woken = await wakeDueSnoozes(db, new Date("2026-06-01T12:00:00Z"));

    expect(woken).toBe(0);
    expect((await threadRow(threadId))?.inInbox).toBe(true);
  });

  it("wakes every due Thread in one sweep, exactly at the boundary (<=, not <)", async () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const dueA = await seedSnoozedThread(new Date("2026-06-01T10:00:00Z"));
    const dueAtBoundary = await seedSnoozedThread(now);
    const notYetDue = await seedSnoozedThread(new Date("2026-06-01T13:00:00Z"));

    const woken = await wakeDueSnoozes(db, now);

    expect(woken).toBe(2);
    expect((await threadRow(dueA))?.inInbox).toBe(true);
    expect((await threadRow(dueAtBoundary))?.inInbox).toBe(true);
    expect((await threadRow(notYetDue))?.inInbox).toBe(false);
  });
});
