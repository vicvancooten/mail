import { randomUUID } from "node:crypto";
import { EMPTY_CONTACT_FIELDS } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ensureLocalAddressBookId } from "../address-books/store.js";
import type { Db } from "../db/client.js";
import { contactLinks, contacts, syncTombstones } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { purgeExpiredContacts } from "./contact-purge.js";
import { linkContacts } from "./link-store.js";
import { insertContact } from "./store.js";

/**
 * `contacts/contact-purge.ts`'s sweep (#224) against a real Postgres —
 * `sync/note-purge.test.ts`'s own reasoning: the 30-day boundary and the
 * tombstone this leaves only exist at the database boundary. The one thing
 * this file adds beyond that template is a `ContactLink` — a Note has none
 * to prune.
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

async function seedContact(deletedAt: Date | null): Promise<string> {
  const addressBookId = await ensureLocalAddressBookId(db, account.userId);
  const contactId = randomUUID();
  await insertContact(db, account.userId, addressBookId, contactId, EMPTY_CONTACT_FIELDS);
  if (deletedAt) {
    await db.update(contacts).set({ deletedAt }).where(eq(contacts.id, contactId));
  }
  return contactId;
}

describe("purgeExpiredContacts", () => {
  it("purges a Contact whose deletedAt is past the 30-day retention window", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const contactId = await seedContact(new Date("2026-05-31T00:00:00Z"));

    const purged = await purgeExpiredContacts(db, now);

    expect(purged).toBe(1);
    const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(row).toBeUndefined();
  });

  it("records a tombstone for every purged Contact — the ordinary destroyed-entity path", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const contactId = await seedContact(new Date("2026-05-31T00:00:00Z"));

    await purgeExpiredContacts(db, now);

    const [tombstone] = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.entityId, contactId));
    expect(tombstone?.collection).toBe("Contact");
    expect(tombstone?.mailAccountId).toBeNull();
  });

  it("leaves a Contact still inside its 30-day window untouched", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const contactId = await seedContact(new Date("2026-06-01T00:00:01Z"));

    const purged = await purgeExpiredContacts(db, now);

    expect(purged).toBe(0);
    const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(row).toBeDefined();
  });

  it("leaves an ordinary, never-deleted Contact untouched", async () => {
    const contactId = await seedContact(null);

    const purged = await purgeExpiredContacts(db, new Date("2026-12-31T00:00:00Z"));

    expect(purged).toBe(0);
    const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(row).toBeDefined();
  });

  it("purges exactly at the 30-day boundary (<=, not <)", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const atBoundary = await seedContact(new Date("2026-05-31T00:00:00Z"));

    const purged = await purgeExpiredContacts(db, now);

    expect(purged).toBe(1);
    const [row] = await db.select().from(contacts).where(eq(contacts.id, atBoundary));
    expect(row).toBeUndefined();
  });

  it("prunes a purged Contact out of its ContactLink — unlike a Note, a Contact can dangle a link", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const expired = await seedContact(new Date("2026-05-31T00:00:00Z"));
    const survivor = await seedContact(null);
    await linkContacts(db, {
      userId: account.userId,
      linkId: randomUUID(),
      contactId: expired,
      otherContactId: survivor,
    });

    await purgeExpiredContacts(db, now);

    // Fewer than two members left dissolves the link outright
    // (`link-store.ts#pruneContactLinkMembers`'s own doc comment).
    const links = await db.select().from(contactLinks);
    expect(links).toHaveLength(0);
  });
});
