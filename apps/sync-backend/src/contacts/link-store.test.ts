import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { addressBooks, contactLinks, contacts, syncTombstones } from "../db/schema.js";
import { flushUserMutations } from "../sync/mutations.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { linkContacts, pruneContactLinkMembers, setContactLinkFront } from "./link-store.js";

/**
 * `contacts/link-store.ts` against a real Postgres (#222) — the invariant
 * worth testing at the database boundary is the one no type can state: a
 * Contact belongs to **at most one** link, through every ordering of links
 * a User can perform, and a link never outlives the Contacts it names.
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

async function seedContact(addressBookId: string, owner = userId): Promise<string> {
  const id = randomUUID();
  await db.insert(contacts).values({ id, addressBookId, userId: owner });
  return id;
}

async function readLinks() {
  return db.select().from(contactLinks).where(eq(contactLinks.userId, userId));
}

describe("linkContacts (#222)", () => {
  it("creates one link naming both records, changing neither Contact row", async () => {
    const book = await seedAddressBook();
    const google = await seedAddressBook({
      connectedAccountId,
      capabilityTableId: "google",
      name: "Google Contacts",
    });
    const a = await seedContact(book);
    const b = await seedContact(google);
    const before = await db.select().from(contacts).where(eq(contacts.id, a));

    const result = await linkContacts(db, {
      userId,
      linkId: "link-1",
      contactId: a,
      otherContactId: b,
    });

    expect(result).toEqual({ ok: true, linkId: "link-1" });
    const links = await readLinks();
    expect(links).toHaveLength(1);
    expect([...(links[0]?.contactIds ?? [])].sort()).toEqual([a, b].sort());
    expect(links[0]?.frontContactId).toBeNull();
    // ADR-0026: "never a change to any record".
    expect(await db.select().from(contacts).where(eq(contacts.id, a))).toEqual(before);
  });

  it("unions into the existing link when one side is already linked", async () => {
    const book = await seedAddressBook();
    const [a, b, c] = [await seedContact(book), await seedContact(book), await seedContact(book)];
    await linkContacts(db, { userId, linkId: "link-1", contactId: a, otherContactId: b });

    const result = await linkContacts(db, {
      userId,
      linkId: "link-2",
      contactId: b,
      otherContactId: c,
    });

    expect(result).toEqual({ ok: true, linkId: "link-1" });
    const links = await readLinks();
    expect(links).toHaveLength(1);
    expect([...(links[0]?.contactIds ?? [])].sort()).toEqual([a, b, c].sort());
  });

  it("folds two separately-linked pairs into one group of four", async () => {
    const book = await seedAddressBook();
    const a = await seedContact(book);
    const b = await seedContact(book);
    const c = await seedContact(book);
    const d = await seedContact(book);
    await linkContacts(db, { userId, linkId: "l-a", contactId: a, otherContactId: b });
    await linkContacts(db, { userId, linkId: "l-b", contactId: c, otherContactId: d });

    await linkContacts(db, { userId, linkId: "l-c", contactId: b, otherContactId: c });

    const links = await readLinks();
    expect(links).toHaveLength(1);
    expect([...(links[0]?.contactIds ?? [])].sort()).toEqual([a, b, c, d].sort());
    // The superseded row is tombstoned, so an open Client actually drops it.
    const tombstones = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.collection, "ContactLink"));
    expect(tombstones).toHaveLength(1);
  });

  it("reports an already-linked pair rather than writing again", async () => {
    const book = await seedAddressBook();
    const a = await seedContact(book);
    const b = await seedContact(book);
    await linkContacts(db, { userId, linkId: "link-1", contactId: a, otherContactId: b });
    const [before] = await readLinks();

    const result = await linkContacts(db, {
      userId,
      linkId: "link-2",
      contactId: a,
      otherContactId: b,
    });

    expect(result).toEqual({ ok: false, reason: "already_linked" });
    expect((await readLinks())[0]?.syncRev).toBe(before?.syncRev);
  });

  it("refuses a Contact another User owns, and refuses linking a record to itself", async () => {
    const book = await seedAddressBook();
    const mine = await seedContact(book);
    const other = await createTestMailAccount(db, { emailAddress: "other@example.com" });
    const theirBook = await seedAddressBook({ userId: other.userId });
    const theirs = await seedContact(theirBook, other.userId);

    expect(
      await linkContacts(db, {
        userId,
        linkId: "l",
        contactId: mine,
        otherContactId: theirs,
      }),
    ).toEqual({ ok: false, reason: "contact_not_found" });
    expect(
      await linkContacts(db, { userId, linkId: "l", contactId: mine, otherContactId: mine }),
    ).toEqual({ ok: false, reason: "same_contact" });
    expect(await readLinks()).toHaveLength(0);
  });
});

describe("setContactLinkFront (#222)", () => {
  it("records the User's pick and clears it again", async () => {
    const book = await seedAddressBook();
    const a = await seedContact(book);
    const b = await seedContact(book);
    await linkContacts(db, { userId, linkId: "link-1", contactId: a, otherContactId: b });

    expect(await setContactLinkFront(db, userId, "link-1", b)).toBe(true);
    expect((await readLinks())[0]?.frontContactId).toBe(b);
    expect(await setContactLinkFront(db, userId, "link-1", null)).toBe(true);
    expect((await readLinks())[0]?.frontContactId).toBeNull();
  });

  it("refuses a record that isn't a member, and a link this User doesn't own", async () => {
    const book = await seedAddressBook();
    const a = await seedContact(book);
    const b = await seedContact(book);
    const stranger = await seedContact(book);
    await linkContacts(db, { userId, linkId: "link-1", contactId: a, otherContactId: b });

    expect(await setContactLinkFront(db, userId, "link-1", stranger)).toBe(false);
    expect(await setContactLinkFront(db, userId, "nope", a)).toBe(false);
  });
});

describe("pruneContactLinkMembers (#222)", () => {
  it("dissolves a pair's link and tombstones it when one record goes", async () => {
    const book = await seedAddressBook();
    const a = await seedContact(book);
    const b = await seedContact(book);
    await linkContacts(db, { userId, linkId: "link-1", contactId: a, otherContactId: b });

    await pruneContactLinkMembers(db, userId, [a]);

    expect(await readLinks()).toHaveLength(0);
    const tombstones = await db
      .select()
      .from(syncTombstones)
      .where(
        and(eq(syncTombstones.collection, "ContactLink"), eq(syncTombstones.entityId, "link-1")),
      );
    expect(tombstones).toHaveLength(1);
  });

  it("keeps a group of three as a group of two, dropping a stale front pick", async () => {
    const book = await seedAddressBook();
    const [a, b, c] = [await seedContact(book), await seedContact(book), await seedContact(book)];
    await linkContacts(db, { userId, linkId: "link-1", contactId: a, otherContactId: b });
    await linkContacts(db, { userId, linkId: "link-2", contactId: b, otherContactId: c });
    await setContactLinkFront(db, userId, "link-1", c);

    await pruneContactLinkMembers(db, userId, [c]);

    const [link] = await readLinks();
    expect([...(link?.contactIds ?? [])].sort()).toEqual([a, b].sort());
    expect(link?.frontContactId).toBeNull();
  });
});

describe("flushUserMutations — Linked Contacts (#222)", () => {
  it("links, re-fronts and unlinks through the ordinary queue", async () => {
    const book = await seedAddressBook();
    const a = await seedContact(book);
    const b = await seedContact(book);

    const linked = await flushUserMutations(db, userId, [
      {
        id: randomUUID(),
        intent: { type: "linkContacts", linkId: "link-1", contactId: a, otherContactId: b },
      },
      {
        id: randomUUID(),
        intent: { type: "setLinkedContactFront", linkId: "link-1", contactId: b },
      },
    ]);
    expect(linked.map((outcome) => outcome.status)).toEqual(["applied", "applied"]);
    expect((await readLinks())[0]?.frontContactId).toBe(b);

    const unlinked = await flushUserMutations(db, userId, [
      { id: randomUUID(), intent: { type: "unlinkContact", contactId: b } },
    ]);
    expect(unlinked[0]?.status).toBe("applied");
    expect(await readLinks()).toHaveLength(0);
  });

  it("drops a link's member when the Contact itself is deleted", async () => {
    const book = await seedAddressBook({ isDefault: true });
    const a = await seedContact(book);
    const b = await seedContact(book);
    await linkContacts(db, { userId, linkId: "link-1", contactId: a, otherContactId: b });

    await flushUserMutations(db, userId, [
      { id: randomUUID(), intent: { type: "deleteContact", contactId: b } },
    ]);

    expect(await readLinks()).toHaveLength(0);
  });

  it("reports a front pick against a link that doesn't exist", async () => {
    const outcomes = await flushUserMutations(db, userId, [
      {
        id: randomUUID(),
        intent: { type: "setLinkedContactFront", linkId: "nope", contactId: null },
      },
    ]);
    expect(outcomes[0]).toMatchObject({ status: "rejected", reason: "contact_link_not_found" });
  });
});
