import {
  EMPTY_CONTACT_FIELDS,
  LOCAL_CONTACT_CAPABILITY_TABLE,
  labelId,
  MICROSOFT_CONTACT_CAPABILITY_TABLE,
} from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAddressBook, makeContact } from "../test-support/mail-fixtures.js";
import { linkContacts, readContactLinks } from "./contact-links.js";
import {
  contactExists,
  copyContact,
  createContact,
  deleteContact,
  labelContact,
  mergeContacts,
  moveContact,
  newContactId,
  readContact,
  readContacts,
  readContactsForAddressBook,
  readDeletedContacts,
  restoreContact,
  trashContact,
  unlabelContact,
  updateContact,
} from "./contacts.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { setSessionUserId } from "./session.js";
import { listQueuedUserMutations } from "./user-mutation-queue.js";

/**
 * #210's own acceptance line: a Contact's id is a client-minted ULID,
 * present before any server round trip; create/update/delete/label/unlabel
 * all ride the User-scoped Optimistic Action queue with real inverses
 * (ADR-0019).
 */

const USER = "user-1";
const ADDRESS_BOOK_ID = "book-1";

function defined<T>(value: T | undefined | null): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as T;
}

const requestSyncNow = vi.fn();
vi.mock("../sync/sync-loop.js", () => ({
  requestSyncNow: () => requestSyncNow(),
}));

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `contacts-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  requestSyncNow.mockClear();
});

afterEach(async () => {
  localCache().close();
  setSessionUserId(null);
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function drainQueue(): Promise<void> {
  const queued = await listQueuedUserMutations();
  await localCache().pendingUserMutations.bulkDelete(queued.map((mutation) => mutation.id));
}

describe("newContactId", () => {
  it("mints a fresh id, offline-derivable before any content exists", () => {
    const id = newContactId();
    expect(id).toMatch(/^[0-9A-Z]{26}$/);
    expect(newContactId()).not.toBe(id);
  });
});

describe("createContact", () => {
  it("writes the durable row optimistically with the given fields", async () => {
    const id = newContactId();
    const fields = { ...EMPTY_CONTACT_FIELDS, name: { given: "Ada" } };

    await createContact(id, ADDRESS_BOOK_ID, fields);

    const row = defined(await readContact(id));
    expect(row).toMatchObject({
      id,
      addressBookId: ADDRESS_BOOK_ID,
      name: { given: "Ada" },
      labelIds: [],
    });
  });

  it("enqueues a createContact intent carrying the same fields", async () => {
    const id = newContactId();
    const fields = { ...EMPTY_CONTACT_FIELDS, notes: "met at a conference" };

    await createContact(id, ADDRESS_BOOK_ID, fields);

    const queued = await listQueuedUserMutations();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.intent).toEqual({
      type: "createContact",
      contactId: id,
      addressBookId: ADDRESS_BOOK_ID,
      fields,
    });
    expect(requestSyncNow).toHaveBeenCalled();
  });
});

describe("deleteContact", () => {
  it("removes the local row and enqueues the inverse intent", async () => {
    const id = newContactId();
    await createContact(id, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);

    await deleteContact(id);

    expect(await readContact(id)).toBeUndefined();
    // `createContact`/`deleteContact` are a genuine inverse pair (ADR-0019):
    // both still queued cancels the pair away rather than shipping either.
    expect(await listQueuedUserMutations()).toEqual([]);
  });

  it("still enqueues deleteContact when the create already flushed", async () => {
    const id = newContactId();
    await createContact(id, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);
    await drainQueue();

    await deleteContact(id);

    const queued = await listQueuedUserMutations();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.intent).toEqual({ type: "deleteContact", contactId: id });
  });
});

describe("updateContact", () => {
  it("merges the new fields into the local row and enqueues the intent", async () => {
    const id = newContactId();
    await createContact(id, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);
    await drainQueue();
    const after = { ...EMPTY_CONTACT_FIELDS, notes: "updated" };

    await updateContact(id, after);

    const row = defined(await readContact(id));
    expect(row.notes).toBe("updated");
    // Identity and Labels are untouched by an ordinary field edit.
    expect(row.id).toBe(id);
    expect(row.labelIds).toEqual([]);
    const queued = await listQueuedUserMutations();
    expect(queued[0]?.intent).toEqual({ type: "updateContact", contactId: id, fields: after });
  });

  it("is its own real inverse — re-applying the previous fields undoes the edit (ADR-0019)", async () => {
    const id = newContactId();
    const before = { ...EMPTY_CONTACT_FIELDS, notes: "before" };
    await createContact(id, ADDRESS_BOOK_ID, before);
    await drainQueue();

    await updateContact(id, { ...EMPTY_CONTACT_FIELDS, notes: "after" });
    await drainQueue();
    await updateContact(id, before);

    expect((await readContact(id))?.notes).toBe("before");
  });

  it("a second edit while one is still queued replaces it rather than stacking", async () => {
    const id = newContactId();
    await createContact(id, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);
    await drainQueue();

    await updateContact(id, { ...EMPTY_CONTACT_FIELDS, notes: "first" });
    await updateContact(id, { ...EMPTY_CONTACT_FIELDS, notes: "second" });

    const queued = await listQueuedUserMutations();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.intent).toMatchObject({ fields: { notes: "second" } });
  });
});

const TARGET_ADDRESS_BOOK_ID = "book-2";

describe("copyContact / moveContact (#225)", () => {
  it("copyContact creates the fields in the target book and links the copy to the source", async () => {
    const source = makeContact("source-1", ADDRESS_BOOK_ID, { name: { given: "Ada" } });

    const newId = await copyContact(source, TARGET_ADDRESS_BOOK_ID, LOCAL_CONTACT_CAPABILITY_TABLE);

    const copy = defined(await readContact(newId));
    expect(copy.addressBookId).toBe(TARGET_ADDRESS_BOOK_ID);
    expect(copy.name).toEqual({ given: "Ada" });
    const links = await readContactLinks();
    expect(links).toHaveLength(1);
    expect(links[0]?.contactIds.sort()).toEqual([newId, source.id].sort());
  });

  it("copyContact trims fields the target's own capability table can't hold", async () => {
    const source = makeContact("source-1", ADDRESS_BOOK_ID, {
      organizations: [
        { id: "o1", name: "Acme" },
        { id: "o2", name: "Widgets Inc" },
      ],
    });

    const newId = await copyContact(
      source,
      TARGET_ADDRESS_BOOK_ID,
      MICROSOFT_CONTACT_CAPABILITY_TABLE,
    );

    const copy = defined(await readContact(newId));
    expect(copy.organizations).toEqual([{ id: "o1", name: "Acme" }]);
  });

  it("moveContact creates the copy without linking it, and deletes the source", async () => {
    const source = makeContact("source-1", ADDRESS_BOOK_ID, { name: { given: "Ada" } });

    const result = await moveContact(
      source,
      TARGET_ADDRESS_BOOK_ID,
      LOCAL_CONTACT_CAPABILITY_TABLE,
    );

    const copy = defined(await readContact(result.newContactId));
    expect(copy.addressBookId).toBe(TARGET_ADDRESS_BOOK_ID);
    expect(await readContactLinks()).toEqual([]);
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent.type)).toContain("deleteContact");
  });

  it("moveContact's undo recreates the original with its own id and removes the copy", async () => {
    const source = makeContact("source-1", ADDRESS_BOOK_ID, {
      name: { given: "Ada" },
      banner: { kind: "swatch", swatch: "b" },
    });

    const result = await moveContact(
      source,
      TARGET_ADDRESS_BOOK_ID,
      LOCAL_CONTACT_CAPABILITY_TABLE,
    );
    await result.undo();

    const restored = defined(await readContact(source.id));
    expect(restored.addressBookId).toBe(ADDRESS_BOOK_ID);
    expect(restored.name).toEqual({ given: "Ada" });
    expect(restored.banner).toEqual({ kind: "swatch", swatch: "b" });
    expect(await readContact(result.newContactId)).toBeUndefined();
  });
});

describe("labelContact / unlabelContact", () => {
  it("applies a Label optimistically and enqueues the intent", async () => {
    const id = newContactId();
    await createContact(id, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);

    await labelContact(id, "VIP");

    const row = defined(await readContact(id));
    expect(row.labelIds).toEqual([labelId(USER, "VIP")]);
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "labelContact",
      contactId: id,
      name: "VIP",
    });
  });

  it("cancels a still-queued labelContact when unlabelContact follows for the same name", async () => {
    const id = newContactId();
    await createContact(id, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);
    await drainQueue();

    await labelContact(id, "VIP");
    await unlabelContact(id, "VIP");

    const row = defined(await readContact(id));
    expect(row.labelIds).toEqual([]);
    expect(await listQueuedUserMutations()).toEqual([]);
  });
});

describe("readContactsForAddressBook", () => {
  it("lists every Contact in the given Address Book, most recently updated first", async () => {
    const a = newContactId();
    const b = newContactId();
    const elsewhere = newContactId();
    await createContact(a, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);
    await createContact(b, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);
    await createContact(elsewhere, "book-2", EMPTY_CONTACT_FIELDS);
    const row = defined(await readContact(b));
    await localCache().contacts.put({ ...row, updatedAt: "2099-01-01T00:00:00.000Z" });

    const rows = await readContactsForAddressBook(ADDRESS_BOOK_ID);
    expect(rows.map((contact) => contact.id)).toEqual([b, a]);
  });

  it("returns nothing for a null Address Book id", async () => {
    expect(await readContactsForAddressBook(null)).toEqual([]);
  });
});

describe("readContacts (#211)", () => {
  it("lists every Contact across every Address Book, for the card directory's own grid", async () => {
    const a = newContactId();
    const b = newContactId();
    await createContact(a, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);
    await createContact(b, "book-2", EMPTY_CONTACT_FIELDS);

    const rows = await readContacts();
    expect(rows.map((row) => row.id).sort()).toEqual([a, b].sort());
  });

  it("is empty before any Contact has synced", async () => {
    expect(await readContacts()).toEqual([]);
  });
});

describe("trashContact / restoreContact (#224, soft delete and Recently Deleted)", () => {
  it("sets deletedAt rather than removing the row, and enqueues the intent", async () => {
    const id = newContactId();
    await createContact(id, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);
    await drainQueue();

    await trashContact(id);

    const row = defined(await readContact(id));
    expect(row.deletedAt).not.toBeNull();
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "trashContact",
      contactId: id,
    });
  });

  it("drops out of readContacts once trashed, and into readDeletedContacts", async () => {
    const id = newContactId();
    await createContact(id, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);

    await trashContact(id);

    expect((await readContacts()).map((row) => row.id)).not.toContain(id);
    expect((await readDeletedContacts()).map((row) => row.id)).toEqual([id]);
  });

  it("restoreContact is the real inverse — Labels untouched, back in readContacts", async () => {
    const id = newContactId();
    await createContact(id, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);
    await labelContact(id, "VIP");
    await trashContact(id);
    await drainQueue();

    await restoreContact(id);

    const row = defined(await readContact(id));
    expect(row.deletedAt).toBeNull();
    expect(row.labelIds).toEqual([labelId(USER, "VIP")]);
    expect((await readContacts()).map((r) => r.id)).toContain(id);
    expect(await readDeletedContacts()).toEqual([]);
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "restoreContact",
      contactId: id,
    });
  });

  it("a still-queued trashContact met by restoreContact cancels the pair away (ADR-0019)", async () => {
    const id = newContactId();
    await createContact(id, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);
    await drainQueue();

    await trashContact(id);
    await restoreContact(id);

    expect(await listQueuedUserMutations()).toEqual([]);
  });

  it("contactExists is false for a soft-deleted Contact — the route guard's own reasoning", async () => {
    const id = newContactId();
    await createContact(id, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);

    await trashContact(id);

    expect(await contactExists(id)).toBe(false);
    // `readContact` itself still hands the row back — the dialog's own
    // `deletedAt` effect needs that undiminished read.
    expect(await readContact(id)).toBeDefined();
  });
});

describe("mergeContacts (#223)", () => {
  beforeEach(async () => {
    await localCache().addressBooks.put(
      makeAddressBook(ADDRESS_BOOK_ID, { capabilityTableId: "local" }),
    );
  });

  async function seedPair(): Promise<{ older: string; newer: string }> {
    const older = newContactId();
    const newer = newContactId();
    await createContact(older, ADDRESS_BOOK_ID, {
      ...EMPTY_CONTACT_FIELDS,
      name: { given: "Ada" },
    });
    await createContact(newer, ADDRESS_BOOK_ID, {
      ...EMPTY_CONTACT_FIELDS,
      emails: [{ id: "e-1", type: "home", value: "ada@lovelace.example", primary: false }],
    });
    await localCache().contacts.update(older, { createdAt: "2020-01-01T00:00:00.000Z" });
    await localCache().contacts.update(newer, { createdAt: "2024-01-01T00:00:00.000Z" });
    await drainQueue();
    return { older, newer };
  }

  it("keeps the older record, taking the other's fields, and deletes the newer one", async () => {
    const { older, newer } = await seedPair();

    const result = await mergeContacts(older, newer);

    expect(result).toEqual({ survivorId: older, loserId: newer });
    const survivor = defined(await readContact(older));
    expect(survivor.name).toEqual({ given: "Ada" });
    expect(survivor.emails.map((entry) => entry.value)).toEqual(["ada@lovelace.example"]);
    expect(await readContact(newer)).toBeUndefined();
  });

  it("survives regardless of which side is named first", async () => {
    const { older, newer } = await seedPair();

    const result = await mergeContacts(newer, older);

    expect(result).toEqual({ survivorId: older, loserId: newer });
  });

  it("enqueues a mergeContacts intent naming the survivor and the loser", async () => {
    const { older, newer } = await seedPair();

    await mergeContacts(older, newer);

    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "mergeContacts",
      contactId: older,
      otherContactId: newer,
    });
  });

  it("drops the deleted record from any Linked Contacts group it belonged to", async () => {
    const { older, newer } = await seedPair();
    const elsewhere = newContactId();
    await createContact(elsewhere, "book-2", EMPTY_CONTACT_FIELDS);
    await linkContacts("link-1", newer, elsewhere);

    await mergeContacts(older, newer);

    expect(await readContactLinks()).toEqual([]);
  });

  it("is a no-op for a cross-Address-Book pair", async () => {
    const local = newContactId();
    const other = newContactId();
    await createContact(local, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);
    await createContact(other, "book-2", EMPTY_CONTACT_FIELDS);
    await drainQueue();

    const result = await mergeContacts(local, other);

    expect(result).toBeNull();
    expect(await readContact(local)).toBeDefined();
    expect(await readContact(other)).toBeDefined();
    expect(await listQueuedUserMutations()).toEqual([]);
  });
});

describe("contactExists (#211)", () => {
  it("is true for a Contact this Client holds locally", async () => {
    const id = newContactId();
    await createContact(id, ADDRESS_BOOK_ID, EMPTY_CONTACT_FIELDS);

    expect(await contactExists(id)).toBe(true);
  });

  it("is false for an id this Client has never synced", async () => {
    expect(await contactExists("does-not-exist")).toBe(false);
  });
});
