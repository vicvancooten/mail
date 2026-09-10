import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { threads } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { computeUnreadInboxCount } from "./badge.js";

/**
 * `computeUnreadInboxCount` against a real Postgres — this is the one
 * counter `routes/sync.ts` (the badge on `/sync`) and the Notifier (every
 * push payload's `badgeCount`) both read, so a wrong `SUM`/`WHERE` here
 * would silently desync the two places ADR-0015 says must never drift.
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

async function seedThread(overrides: { unreadCount: number; inInbox: boolean }): Promise<void> {
  await db.insert(threads).values({
    id: randomUUID(),
    mailAccountId: account.id,
    unreadCount: overrides.unreadCount,
    inInbox: overrides.inInbox,
  });
}

describe("computeUnreadInboxCount", () => {
  it("sums unread Inbox Threads across this User's Mail Accounts", async () => {
    await seedThread({ unreadCount: 2, inInbox: true });
    await seedThread({ unreadCount: 1, inInbox: true });
    expect(await computeUnreadInboxCount(db, account.userId)).toBe(3);
  });

  it("excludes a Thread that has dropped out of the Inbox (archived/trashed, #42)", async () => {
    await seedThread({ unreadCount: 5, inInbox: false });
    expect(await computeUnreadInboxCount(db, account.userId)).toBe(0);
  });

  it("excludes a Thread with nothing unread", async () => {
    await seedThread({ unreadCount: 0, inInbox: true });
    expect(await computeUnreadInboxCount(db, account.userId)).toBe(0);
  });

  it("is 0 for a User with no Threads at all", async () => {
    expect(await computeUnreadInboxCount(db, account.userId)).toBe(0);
  });

  it("sums across every Mail Account this User owns, not just one", async () => {
    // A second Mail Account under the *same* User (CONTEXT.md: a User owns
    // one or more) — its own Connected Account and Mail Facet, `userId`
    // pinned to the first account's own User.
    const second = await createTestMailAccount(db, {
      userId: account.userId,
      emailAddress: `second-${randomUUID()}@mail.test`,
    });

    await seedThread({ unreadCount: 3, inInbox: true });
    await db.insert(threads).values({
      id: randomUUID(),
      mailAccountId: second.id,
      unreadCount: 4,
      inInbox: true,
    });

    expect(await computeUnreadInboxCount(db, account.userId)).toBe(7);
  });
});
