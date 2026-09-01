import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { insertOutboxEntry, listUndelivered, markDelivered } from "./outbox.js";

/**
 * The Notifier's outbox (#53, ADR-0015) against a real Postgres — dedup is a
 * database-level unique index, and "undelivered" is a `WHERE` clause; both
 * are statements, not pure functions.
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

describe("insertOutboxEntry", () => {
  it("inserts a row and reports it as undelivered", async () => {
    const inserted = await insertOutboxEntry(db, {
      userId: account.userId,
      mailAccountId: account.id,
      kind: "needs_reauth",
      dedupKey: `${account.id}:1`,
      payload: { kind: "needs_reauth", emailAddress: account.emailAddress },
    });
    expect(inserted).toBe(true);
    const pending = await listUndelivered(db);
    expect(pending.map((row) => row.dedupKey)).toEqual([`${account.id}:1`]);
  });

  it("absorbs a duplicate (kind, dedupKey) rather than erroring", async () => {
    const input = {
      userId: account.userId,
      mailAccountId: account.id,
      kind: "failed_send" as const,
      dedupKey: "composition-1",
      payload: {
        kind: "failed_send" as const,
        compositionId: "composition-1",
        subject: "Hi",
        detail: "550 rejected",
      },
    };
    expect(await insertOutboxEntry(db, input)).toBe(true);
    expect(await insertOutboxEntry(db, input)).toBe(false);
    expect(await listUndelivered(db)).toHaveLength(1);
  });

  it("treats the same dedupKey under a different kind as a distinct event", async () => {
    const dedupKey = "shared-key";
    expect(
      await insertOutboxEntry(db, {
        userId: account.userId,
        mailAccountId: account.id,
        kind: "needs_reauth",
        dedupKey,
        payload: { kind: "needs_reauth", emailAddress: account.emailAddress },
      }),
    ).toBe(true);
    expect(
      await insertOutboxEntry(db, {
        userId: account.userId,
        mailAccountId: account.id,
        kind: "failed_send",
        dedupKey,
        payload: {
          kind: "failed_send",
          compositionId: dedupKey,
          subject: "Hi",
          detail: "rejected",
        },
      }),
    ).toBe(true);
    expect(await listUndelivered(db)).toHaveLength(2);
  });
});

describe("markDelivered", () => {
  it("removes rows from the undelivered set once marked", async () => {
    await insertOutboxEntry(db, {
      userId: account.userId,
      mailAccountId: account.id,
      kind: "needs_reauth",
      dedupKey: `${account.id}:1`,
      payload: { kind: "needs_reauth", emailAddress: account.emailAddress },
    });
    const [pending] = await listUndelivered(db);
    if (!pending) throw new Error("expected a pending row");

    await markDelivered(db, [pending.id]);
    expect(await listUndelivered(db)).toEqual([]);
  });

  it("is a no-op for an empty id list", async () => {
    await expect(markDelivered(db, [])).resolves.toBeUndefined();
  });
});
