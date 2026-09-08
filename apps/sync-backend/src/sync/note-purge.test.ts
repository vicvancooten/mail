import { randomUUID } from "node:crypto";
import { EMPTY_NOTE_DOCUMENT } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { notes, syncTombstones } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { purgeExpiredNotes } from "./note-purge.js";

/**
 * `sync/note-purge.ts`'s sweep (#194) against a real Postgres — the
 * interesting property (the 30-day boundary, and the tombstone this leaves
 * for every Client's next `POST /sync` to read) only exists at the database
 * boundary, the same reasoning `snooze.test.ts` gives its own sweep.
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

describe("purgeExpiredNotes", () => {
  it("purges a Note whose deletedAt is past the 30-day retention window", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const noteId = await seedNote(new Date("2026-05-31T00:00:00Z"));

    const purged = await purgeExpiredNotes(db, now);

    expect(purged).toBe(1);
    const [row] = await db.select().from(notes).where(eq(notes.id, noteId));
    expect(row).toBeUndefined();
  });

  it("records a tombstone for every purged Note — the ordinary destroyed-entity path", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const noteId = await seedNote(new Date("2026-05-31T00:00:00Z"));

    await purgeExpiredNotes(db, now);

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

    const purged = await purgeExpiredNotes(db, now);

    expect(purged).toBe(0);
    const [row] = await db.select().from(notes).where(eq(notes.id, noteId));
    expect(row).toBeDefined();
  });

  it("leaves an ordinary, never-deleted Note untouched", async () => {
    const noteId = await seedNote(null);

    const purged = await purgeExpiredNotes(db, new Date("2026-12-31T00:00:00Z"));

    expect(purged).toBe(0);
    const [row] = await db.select().from(notes).where(eq(notes.id, noteId));
    expect(row).toBeDefined();
  });

  it("purges exactly at the 30-day boundary (<=, not <)", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const atBoundary = await seedNote(new Date("2026-05-31T00:00:00Z"));

    const purged = await purgeExpiredNotes(db, now);

    expect(purged).toBe(1);
    const [row] = await db.select().from(notes).where(eq(notes.id, atBoundary));
    expect(row).toBeUndefined();
  });
});
