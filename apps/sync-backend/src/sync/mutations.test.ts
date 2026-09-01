import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { appliedMutations, folders, messages, threads } from "../db/schema.js";
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

/** One Thread with one Message, the way `ingest.ts` would have stored it. */
async function seedThread(overrides: { seen?: boolean; flagged?: boolean } = {}): Promise<string> {
  const threadId = await resolveThread(db, {
    mailAccountId: account.id,
    threadingIds: [randomUUID()],
    subject: "Test",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
  });
  const folderId = randomUUID();
  await db.insert(folders).values({
    id: folderId,
    mailAccountId: account.id,
    path: "INBOX",
    name: "INBOX",
    role: "inbox",
  });
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

async function threadRow(threadId: string) {
  const [row] = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
  return row;
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
