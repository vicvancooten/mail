import { randomUUID } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { addressBooks, contacts, syncTombstones } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  AddressBookNotFoundError,
  AddressBookNotMirrorableError,
  ensureLocalAddressBook,
  mirrorAddressBook,
  unmirrorAddressBook,
  unmirrorAddressBookImpact,
} from "./store.js";

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

async function createMirroredAddressBook(
  userId: string,
  connectedAccountId: string,
  overrides: Partial<typeof addressBooks.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(addressBooks).values({
    id,
    userId,
    connectedAccountId,
    name: "Google Contacts",
    capabilityTableId: "google",
    mirrored: true,
    isDefault: false,
    googleSyncToken: "some-token",
    googleSyncTokenMintedAt: new Date(),
    ...overrides,
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

describe("unmirrorAddressBook", () => {
  it("discards every Contact, tombstones them, and flips mirrored off", async () => {
    const { userId, connectedAccountId } = await createTestMailAccount(db);
    const addressBookId = await createMirroredAddressBook(userId, connectedAccountId);
    const contactId = await createContact(userId, addressBookId, connectedAccountId);

    const { addressBook, discarded } = await unmirrorAddressBook(db, userId, addressBookId);

    expect(discarded).toEqual({ contacts: 1 });
    expect(addressBook.mirrored).toBe(false);

    const remainingContacts = await db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(remainingContacts).toHaveLength(0);

    const tombstones = await db.select().from(syncTombstones);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.collection).toBe("Contact");
    expect(tombstones[0]?.entityId).toBe(contactId);
  });

  it("keeps the Address Book row so it can be re-mirrored later", async () => {
    const { userId, connectedAccountId } = await createTestMailAccount(db);
    const addressBookId = await createMirroredAddressBook(userId, connectedAccountId);

    await unmirrorAddressBook(db, userId, addressBookId);

    const rows = await db.select().from(addressBooks).where(eq(addressBooks.id, addressBookId));
    expect(rows).toHaveLength(1);
  });

  it("clears the Google sync cursor so a re-mirror starts a fresh full walk", async () => {
    const { userId, connectedAccountId } = await createTestMailAccount(db);
    const addressBookId = await createMirroredAddressBook(userId, connectedAccountId);

    const { addressBook } = await unmirrorAddressBook(db, userId, addressBookId);

    expect(addressBook.googleSyncToken).toBeNull();
    expect(addressBook.googleSyncTokenMintedAt).toBeNull();
  });

  it("falls back the Default Address Book to Local silently", async () => {
    const { userId, connectedAccountId } = await createTestMailAccount(db);
    const addressBookId = await createMirroredAddressBook(userId, connectedAccountId, {
      isDefault: true,
    });

    const { addressBook } = await unmirrorAddressBook(db, userId, addressBookId);

    expect(addressBook.isDefault).toBe(false);
    const [local] = await db
      .select()
      .from(addressBooks)
      .where(isNull(addressBooks.connectedAccountId));
    expect(local?.isDefault).toBe(true);
  });

  it("is idempotent — unmirroring an already-unmirrored Address Book discards nothing further", async () => {
    const { userId, connectedAccountId } = await createTestMailAccount(db);
    const addressBookId = await createMirroredAddressBook(userId, connectedAccountId, {
      mirrored: false,
    });
    await createContact(userId, addressBookId, connectedAccountId);

    const { discarded } = await unmirrorAddressBook(db, userId, addressBookId);

    expect(discarded).toEqual({ contacts: 0 });
    const remainingContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.addressBookId, addressBookId));
    expect(remainingContacts).toHaveLength(1);
  });

  it("refuses an Address Book id belonging to another User", async () => {
    const { userId } = await createTestMailAccount(db);
    const { userId: otherUserId, connectedAccountId: otherConnectedAccountId } =
      await createTestMailAccount(db);
    const addressBookId = await createMirroredAddressBook(otherUserId, otherConnectedAccountId);

    await expect(unmirrorAddressBook(db, userId, addressBookId)).rejects.toBeInstanceOf(
      AddressBookNotFoundError,
    );
  });

  it("refuses the Local Address Book — there is no checklist to turn it off from", async () => {
    const { userId } = await createTestMailAccount(db);
    await ensureLocalAddressBook(db, userId);
    const [local] = await db
      .select()
      .from(addressBooks)
      .where(isNull(addressBooks.connectedAccountId));

    await expect(unmirrorAddressBook(db, userId, local?.id ?? "")).rejects.toBeInstanceOf(
      AddressBookNotMirrorableError,
    );
  });
});

describe("mirrorAddressBook", () => {
  it("flips mirrored back on", async () => {
    const { userId, connectedAccountId } = await createTestMailAccount(db);
    const addressBookId = await createMirroredAddressBook(userId, connectedAccountId, {
      mirrored: false,
    });

    const addressBook = await mirrorAddressBook(db, userId, addressBookId);

    expect(addressBook.mirrored).toBe(true);
  });

  it("is idempotent for an already-mirrored Address Book", async () => {
    const { userId, connectedAccountId } = await createTestMailAccount(db);
    const addressBookId = await createMirroredAddressBook(userId, connectedAccountId, {
      mirrored: true,
    });

    const addressBook = await mirrorAddressBook(db, userId, addressBookId);

    expect(addressBook.mirrored).toBe(true);
  });
});

describe("unmirrorAddressBookImpact", () => {
  it("previews the discard count without deleting anything", async () => {
    const { userId, connectedAccountId } = await createTestMailAccount(db);
    const addressBookId = await createMirroredAddressBook(userId, connectedAccountId);
    await createContact(userId, addressBookId, connectedAccountId);
    await createContact(userId, addressBookId, connectedAccountId);

    const impact = await unmirrorAddressBookImpact(db, userId, addressBookId);

    expect(impact).toEqual({ contacts: 2 });
    const remainingContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.addressBookId, addressBookId));
    expect(remainingContacts).toHaveLength(2);
  });
});
