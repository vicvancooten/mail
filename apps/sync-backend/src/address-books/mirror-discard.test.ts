import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { addressBooks, contacts, syncTombstones } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { countMirroredContacts, discardMirroredContacts } from "./mirror-discard.js";

let db: Db;
let closeDb: () => Promise<void>;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

async function createMirroredAddressBook(userId: string, connectedAccountId: string) {
  const id = randomUUID();
  await db.insert(addressBooks).values({
    id,
    userId,
    connectedAccountId,
    name: "Google Contacts",
    capabilityTableId: "google",
    mirrored: true,
    isDefault: false,
  });
  return id;
}

async function createContact(userId: string, addressBookId: string, connectedAccountId: string) {
  const id = randomUUID();
  await db.insert(contacts).values({
    id,
    addressBookId,
    userId,
    connectedAccountId,
    googleResourceName: `people/${id}`,
  });
  return id;
}

describe("discardMirroredContacts", () => {
  it("is a no-op for an Address Book with no Contacts", async () => {
    const { userId, connectedAccountId } = await createTestMailAccount(db);
    const addressBookId = await createMirroredAddressBook(userId, connectedAccountId);

    const counts = await discardMirroredContacts(db, addressBookId);

    expect(counts).toEqual({ contacts: 0 });
    expect(await db.select().from(syncTombstones)).toHaveLength(0);
  });

  it("deletes and tombstones only the target Address Book's own Contacts", async () => {
    const { userId, connectedAccountId } = await createTestMailAccount(db);
    const { connectedAccountId: otherConnectedAccountId } = await createTestMailAccount(db, {
      userId,
    });
    const addressBookId = await createMirroredAddressBook(userId, connectedAccountId);
    const otherAddressBookId = await createMirroredAddressBook(userId, otherConnectedAccountId);
    await createContact(userId, addressBookId, connectedAccountId);
    await createContact(userId, addressBookId, connectedAccountId);
    const untouchedContactId = await createContact(
      userId,
      otherAddressBookId,
      otherConnectedAccountId,
    );

    const counts = await discardMirroredContacts(db, addressBookId);

    expect(counts).toEqual({ contacts: 2 });
    const remaining = await db.select().from(contacts);
    expect(remaining.map((row) => row.id)).toEqual([untouchedContactId]);

    const tombstones = await db.select().from(syncTombstones);
    expect(tombstones).toHaveLength(2);
    expect(tombstones.every((row) => row.collection === "Contact")).toBe(true);
  });
});

describe("countMirroredContacts", () => {
  it("counts without deleting", async () => {
    const { userId, connectedAccountId } = await createTestMailAccount(db);
    const addressBookId = await createMirroredAddressBook(userId, connectedAccountId);
    await createContact(userId, addressBookId, connectedAccountId);

    const counts = await countMirroredContacts(db, addressBookId);

    expect(counts).toEqual({ contacts: 1 });
    expect(
      await db.select().from(contacts).where(eq(contacts.addressBookId, addressBookId)),
    ).toHaveLength(1);
  });
});
