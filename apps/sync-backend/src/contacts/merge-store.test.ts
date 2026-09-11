import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  addressBooks,
  contactLinks,
  contacts,
  microsoftContactWrites,
  syncTombstones,
} from "../db/schema.js";
import { flushUserMutations } from "../sync/mutations.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { linkContacts } from "./link-store.js";
import { mergeContacts } from "./merge-store.js";

/**
 * `contacts/merge-store.ts` (#223) against a real Postgres —
 * `link-store.test.ts`'s own shape, exercising the write path a real,
 * destructive Merge takes: the survivor's fields are whole-replaced, the
 * loser is permanently deleted, and both still ride `updateContact`/
 * `deleteContact`'s own side effects (a `ContactLink` prune, a Graph
 * write-through outbox row).
 */
let db: Db;
let closeDb: () => Promise<void>;
let userId: string;
let connectedAccountId: string;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  const account = await createTestMailAccount(db);
  userId = account.userId;
  connectedAccountId = account.connectedAccountId;
});

afterAll(async () => {
  await closeDb?.();
});

async function seedAddressBook(
  overrides: Partial<typeof addressBooks.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(addressBooks).values({
    id,
    userId,
    connectedAccountId: null,
    name: "My Contacts",
    capabilityTableId: "local",
    ...overrides,
  });
  return id;
}

async function seedContact(
  addressBookId: string,
  overrides: Partial<typeof contacts.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db.insert(contacts).values({ id, addressBookId, userId, ...overrides });
  return id;
}

async function readContactRow(id: string) {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, id));
  return row;
}

describe("mergeContacts (#223)", () => {
  it("keeps the older record, taking the other's fields, and deletes the newer one", async () => {
    const book = await seedAddressBook();
    const older = await seedContact(book, {
      name: { given: "Ada" },
      emails: [{ id: "e-1", type: "home", value: "ada@example.com", primary: false }],
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const newer = await seedContact(book, {
      emails: [{ id: "e-2", type: "home", value: "ada@lovelace.example", primary: false }],
      organizations: [{ id: "o-1", name: "Cogworks" }],
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });

    const result = await mergeContacts(db, { userId, contactId: older, otherContactId: newer });

    expect(result).toEqual({ ok: true, survivorId: older });
    const survivorRow = await readContactRow(older);
    expect(survivorRow?.name).toEqual({ given: "Ada" });
    expect(survivorRow?.emails.map((entry) => entry.value)).toEqual([
      "ada@example.com",
      "ada@lovelace.example",
    ]);
    expect(survivorRow?.organizations).toEqual([{ id: "o-1", name: "Cogworks" }]);
    expect(await readContactRow(newer)).toBeUndefined();
  });

  it("survives regardless of which side is named contactId vs otherContactId", async () => {
    const book = await seedAddressBook();
    const older = await seedContact(book, { createdAt: new Date("2020-01-01T00:00:00.000Z") });
    const newer = await seedContact(book, { createdAt: new Date("2024-01-01T00:00:00.000Z") });

    const result = await mergeContacts(db, {
      userId,
      contactId: newer,
      otherContactId: older,
    });

    expect(result).toEqual({ ok: true, survivorId: older });
  });

  it("tombstones the deleted record", async () => {
    const book = await seedAddressBook();
    const older = await seedContact(book, { createdAt: new Date("2020-01-01T00:00:00.000Z") });
    const newer = await seedContact(book, { createdAt: new Date("2024-01-01T00:00:00.000Z") });

    await mergeContacts(db, { userId, contactId: older, otherContactId: newer });

    const tombstones = await db
      .select()
      .from(syncTombstones)
      .where(and(eq(syncTombstones.collection, "Contact"), eq(syncTombstones.entityId, newer)));
    expect(tombstones).toHaveLength(1);
  });

  it("drops the deleted record from any ContactLink it belonged to", async () => {
    const book = await seedAddressBook();
    const google = await seedAddressBook({ connectedAccountId, capabilityTableId: "google" });
    const older = await seedContact(book, { createdAt: new Date("2020-01-01T00:00:00.000Z") });
    const newer = await seedContact(book, { createdAt: new Date("2024-01-01T00:00:00.000Z") });
    const linked = await seedContact(google);
    await linkContacts(db, { userId, linkId: "link-1", contactId: newer, otherContactId: linked });

    await mergeContacts(db, { userId, contactId: older, otherContactId: newer });

    const [link] = await db.select().from(contactLinks).where(eq(contactLinks.id, "link-1"));
    expect(link).toBeUndefined();
  });

  it("truncates a unioned family that overflows the capability table's own cap (Graph's one organisation)", async () => {
    const book = await seedAddressBook({ capabilityTableId: "microsoft" });
    const older = await seedContact(book, {
      organizations: [{ id: "o-1", name: "Cogworks" }],
      microsoftId: "graph-1",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const newer = await seedContact(book, {
      organizations: [{ id: "o-2", name: "Analytical Engines Ltd" }],
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });

    const result = await mergeContacts(db, { userId, contactId: older, otherContactId: newer });

    expect(result).toEqual({ ok: true, survivorId: older });
    const survivorRow = await readContactRow(older);
    expect(survivorRow?.organizations).toEqual([{ id: "o-1", name: "Cogworks" }]);
  });

  it("enqueues Graph's write-through outbox for a mirrored survivor and a mirrored loser", async () => {
    const book = await seedAddressBook({ capabilityTableId: "microsoft" });
    const older = await seedContact(book, {
      microsoftId: "graph-older",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const newer = await seedContact(book, {
      microsoftId: "graph-newer",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });

    await mergeContacts(db, { userId, contactId: older, otherContactId: newer });

    const writes = await db
      .select()
      .from(microsoftContactWrites)
      .where(eq(microsoftContactWrites.addressBookId, book));
    expect(writes).toHaveLength(2);
    expect(writes.map((row) => row.kind).sort()).toEqual(["delete", "upsert"]);
    expect(writes.find((row) => row.kind === "delete")?.microsoftId).toBe("graph-newer");
    expect(writes.find((row) => row.kind === "upsert")?.contactId).toBe(older);
  });

  it("refuses a pair in two different Address Books, and the same record twice", async () => {
    const book = await seedAddressBook();
    const otherBook = await seedAddressBook({ connectedAccountId, capabilityTableId: "google" });
    const a = await seedContact(book);
    const b = await seedContact(otherBook);

    expect(await mergeContacts(db, { userId, contactId: a, otherContactId: b })).toEqual({
      ok: false,
      reason: "different_address_book",
    });
    expect(await mergeContacts(db, { userId, contactId: a, otherContactId: a })).toEqual({
      ok: false,
      reason: "same_contact",
    });
  });

  it("refuses a Contact this User doesn't own", async () => {
    const book = await seedAddressBook();
    const mine = await seedContact(book);
    const other = await createTestMailAccount(db, { emailAddress: "other@example.com" });
    const [theirBook] = await db
      .insert(addressBooks)
      .values({
        id: randomUUID(),
        userId: other.userId,
        connectedAccountId: null,
        name: "Their Contacts",
        capabilityTableId: "local",
      })
      .returning({ id: addressBooks.id });
    const [theirs] = await db
      .insert(contacts)
      .values({ id: randomUUID(), addressBookId: theirBook?.id ?? "", userId: other.userId })
      .returning({ id: contacts.id });

    expect(
      await mergeContacts(db, { userId, contactId: mine, otherContactId: theirs?.id ?? "" }),
    ).toEqual({ ok: false, reason: "contact_not_found" });
  });

  it("reaches upstream through the ordinary flushUserMutations queue", async () => {
    const book = await seedAddressBook();
    const older = await seedContact(book, {
      name: { given: "Ada" },
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const newer = await seedContact(book, { createdAt: new Date("2024-01-01T00:00:00.000Z") });

    const outcomes = await flushUserMutations(db, userId, [
      {
        id: randomUUID(),
        intent: { type: "mergeContacts", contactId: newer, otherContactId: older },
      },
    ]);

    expect(outcomes[0]?.status).toBe("applied");
    expect(await readContactRow(older)).toBeDefined();
    expect(await readContactRow(newer)).toBeUndefined();
  });
});
