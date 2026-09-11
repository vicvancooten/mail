import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMicrosoftDeltaLink,
  listMicrosoftAddressBooksForConnectedAccount,
  mirrorAddressBook,
  unmirrorAddressBook,
} from "../../address-books/store.js";
import type { Db } from "../../db/client.js";
import { contacts, microsoftContactWrites } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import { createTestMailAccount } from "../../test-support/mail-account.js";
import { enqueueMicrosoftContactWrite } from "../store.js";
import type { DeltaContactsResult, GraphContact, MicrosoftContactsClient } from "./client.js";
import { GraphDeltaResyncRequiredError } from "./client.js";
import { drainMicrosoftContactWrites, syncMicrosoftContactsForAccount } from "./contacts-sync.js";

/**
 * `syncMicrosoftContactsForAccount`/`drainMicrosoftContactWrites` (#227)
 * against a fake `MicrosoftContactsClient` and the real test database —
 * `client.test.ts` already covers the wire format, so every test here only
 * ever asserts on sync/write policy: folder discovery, a fresh vs.
 * incremental delta round, `410 Gone` recovery, and the write path's own
 * `changeKey` compare.
 */

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

function graphContact(id: string, overrides: Partial<GraphContact> = {}): GraphContact {
  return { id, changeKey: `${id}-ck1`, givenName: "Ada", ...overrides };
}

function fakeClient(overrides: Partial<MicrosoftContactsClient> = {}): MicrosoftContactsClient {
  return {
    listContactFolders: vi.fn(async () => []),
    defaultContactFolderId: vi.fn(async () => "root-folder"),
    deltaContacts: vi.fn(async () => ({ contacts: [] }) satisfies DeltaContactsResult),
    getContact: vi.fn(async () => null),
    createContact: vi.fn(async () => ({ id: "created-id", changeKey: "created-ck" })),
    updateContact: vi.fn(async () => ({ id: "c1", changeKey: "updated-ck" })),
    deleteContact: vi.fn(async () => undefined),
    getContactPhoto: vi.fn(async () => null),
    ...overrides,
  };
}

async function setUpAccount() {
  const mailAccount = await createTestMailAccount(db, {
    oauth: { accessToken: "mail-token", provider: "microsoft" },
  });
  return { userId: mailAccount.userId, connectedAccountId: mailAccount.connectedAccountId };
}

/** The one Address Book a test expects to exist after a sync tick — throws with a clear message rather than a bare non-null assertion when the sync didn't mint it. */
async function theAddressBook(connectedAccountId: string) {
  const [row] = await listMicrosoftAddressBooksForConnectedAccount(db, connectedAccountId);
  if (!row) throw new Error("expected a mirrored Address Book to exist");
  return row;
}

describe("a first (fresh) delta round", () => {
  it("mints one Address Book for the default folder, mirrors every contact, and stores the deltaLink", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client = fakeClient({
      deltaContacts: vi.fn(async () => ({
        contacts: [
          graphContact("c1", { givenName: "Ada", surname: "Lovelace" }),
          graphContact("c2", { givenName: "Grace" }),
        ],
        deltaLink:
          "https://graph.microsoft.com/v1.0/me/contactFolders/root-folder/contacts/delta?token=1",
      })),
    });

    await syncMicrosoftContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    const books = await listMicrosoftAddressBooksForConnectedAccount(db, connectedAccountId);
    expect(books).toHaveLength(1);
    expect(books[0]?.mirrored).toBe(true);
    expect(books[0]?.capabilityTableId).toBe("microsoft");
    expect(books[0]?.microsoftFolderId).toBe("root-folder");
    expect(books[0]?.microsoftDeltaLink).toBe(
      "https://graph.microsoft.com/v1.0/me/contactFolders/root-folder/contacts/delta?token=1",
    );

    const book = await theAddressBook(connectedAccountId);
    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(rows.map((row) => row.microsoftId).sort()).toEqual(["c1", "c2"]);
    const c1 = rows.find((row) => row.microsoftId === "c1");
    expect(c1?.name).toEqual({ given: "Ada", family: "Lovelace" });
    expect(c1?.microsoftChangeKey).toBe("c1-ck1");
  });

  it("discovers a named folder alongside the default one", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client = fakeClient({
      listContactFolders: vi.fn(async () => [
        { id: "work-folder", displayName: "Work", parentFolderId: "root-folder" },
      ]),
    });

    await syncMicrosoftContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    const books = await listMicrosoftAddressBooksForConnectedAccount(db, connectedAccountId);
    expect(books.map((book) => book.microsoftFolderId).sort()).toEqual([
      "root-folder",
      "work-folder",
    ]);
    expect(books.find((book) => book.microsoftFolderId === "work-folder")?.name).toBe("Work");
    // `defaultContactFolderId` (the "no named folder yet" fallback) is never
    // called once a named folder's own `parentFolderId` already names it.
    expect(client.defaultContactFolderId).not.toHaveBeenCalled();
  });

  it("tombstones a Contact the walk no longer sees", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const deltaContacts = vi
      .fn<MicrosoftContactsClient["deltaContacts"]>()
      .mockResolvedValueOnce({
        contacts: [graphContact("c1"), graphContact("c2")],
        deltaLink: "link-1",
      })
      .mockResolvedValueOnce({ contacts: [graphContact("c1")], deltaLink: "link-2" });
    const client = fakeClient({ deltaContacts });

    await syncMicrosoftContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });
    const book = await theAddressBook(connectedAccountId);
    // Force another fresh walk by clearing the stored deltaLink, the same
    // "next tick with no stored link" trigger a real 410 would cause.
    await clearMicrosoftDeltaLink(db, book.id);

    await syncMicrosoftContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(rows.map((row) => row.microsoftId)).toEqual(["c1"]);
  });
});

describe("an incremental delta round", () => {
  it("applies an upsert and an @removed marker without reconciling the rest", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const first = fakeClient({
      deltaContacts: vi.fn(async () => ({
        contacts: [graphContact("c1"), graphContact("c2")],
        deltaLink: "link-1",
      })),
    });
    await syncMicrosoftContactsForAccount(db, first, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });
    const book = await theAddressBook(connectedAccountId);

    const second = fakeClient({
      deltaContacts: vi.fn(async (_token, _folderId, deltaLink) => {
        expect(deltaLink).toBe("link-1");
        return {
          contacts: [
            graphContact("c1", { givenName: "Grace", changeKey: "c1-ck2" }),
            { id: "c2", changeKey: "c2-ck1", "@removed": { reason: "deleted" } } as GraphContact,
          ],
          deltaLink: "link-2",
        };
      }),
    });
    await syncMicrosoftContactsForAccount(db, second, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.microsoftId).toBe("c1");
    expect(rows[0]?.name).toEqual({ given: "Grace" });
    expect(rows[0]?.microsoftChangeKey).toBe("c1-ck2");
  });

  it("recovers with a fresh walk on a 410 Gone, never retrying the stale link", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const first = fakeClient({
      deltaContacts: vi.fn(async () => ({
        contacts: [graphContact("c1")],
        deltaLink: "stale-link",
      })),
    });
    await syncMicrosoftContactsForAccount(db, first, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    let call = 0;
    const recovering = fakeClient({
      deltaContacts: vi.fn(async (_token, _folderId, deltaLink) => {
        call += 1;
        if (call === 1) {
          expect(deltaLink).toBe("stale-link");
          throw new GraphDeltaResyncRequiredError();
        }
        expect(deltaLink).toBeUndefined();
        return { contacts: [graphContact("c1"), graphContact("c3")], deltaLink: "fresh-link" };
      }),
    });
    await syncMicrosoftContactsForAccount(db, recovering, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    expect(recovering.deltaContacts).toHaveBeenCalledTimes(2);
    const book = await theAddressBook(connectedAccountId);
    expect(book.microsoftDeltaLink).toBe("fresh-link");
    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(rows.map((row) => row.microsoftId).sort()).toEqual(["c1", "c3"]);
  });
});

describe("drainMicrosoftContactWrites", () => {
  async function mirrorOneContact(client: MicrosoftContactsClient) {
    const { userId, connectedAccountId } = await setUpAccount();
    await syncMicrosoftContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });
    const book = await theAddressBook(connectedAccountId);
    const [row] = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    if (!row) throw new Error("expected a mirrored Contact to exist");
    return { book, contactId: row.id };
  }

  it("creates a not-yet-mirrored local Contact upstream and records its id/changeKey", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client = fakeClient();
    await syncMicrosoftContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });
    const book = await theAddressBook(connectedAccountId);

    // A Contact created locally under this Address Book with no upstream id yet.
    const localId = "local-only-id";
    await db.insert(contacts).values({
      id: localId,
      addressBookId: book.id,
      userId,
      connectedAccountId,
      name: { given: "New" },
    });
    await enqueueMicrosoftContactWrite(db, {
      addressBookId: book.id,
      contactId: localId,
      kind: "upsert",
    });

    await drainMicrosoftContactWrites(db, client, book, "at");

    expect(client.createContact).toHaveBeenCalledWith("at", "root-folder", expect.any(Object));
    const [row] = await db.select().from(contacts).where(eq(contacts.id, localId));
    expect(row?.microsoftId).toBe("created-id");
    expect(row?.microsoftChangeKey).toBe("created-ck");
    const remaining = await db.select().from(microsoftContactWrites);
    expect(remaining).toHaveLength(0);
  });

  it("pushes an edit through when the fresh changeKey still matches", async () => {
    const client = fakeClient({
      deltaContacts: vi.fn(async () => ({ contacts: [graphContact("c1")], deltaLink: "link-1" })),
      getContact: vi.fn(async () => ({ id: "c1", changeKey: "c1-ck1" })),
    });
    const { book, contactId } = await mirrorOneContact(client);
    await enqueueMicrosoftContactWrite(db, { addressBookId: book.id, contactId, kind: "upsert" });

    await drainMicrosoftContactWrites(db, client, book, "at");

    expect(client.updateContact).toHaveBeenCalledWith("at", "c1", expect.any(Object));
    const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(row?.microsoftChangeKey).toBe("updated-ck");
  });

  it("skips the push when the fresh changeKey no longer matches (the lost-update guard)", async () => {
    const client = fakeClient({
      deltaContacts: vi.fn(async () => ({ contacts: [graphContact("c1")], deltaLink: "link-1" })),
      getContact: vi.fn(async () => ({ id: "c1", changeKey: "someone-else-changed-it" })),
    });
    const { book, contactId } = await mirrorOneContact(client);
    await enqueueMicrosoftContactWrite(db, { addressBookId: book.id, contactId, kind: "upsert" });

    await drainMicrosoftContactWrites(db, client, book, "at");

    expect(client.updateContact).not.toHaveBeenCalled();
    const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId));
    // Never overwritten locally either — this Contact's own changeKey stays
    // whatever the last sync round actually saw.
    expect(row?.microsoftChangeKey).toBe("c1-ck1");
  });

  it("deletes upstream by the captured microsoftId, never re-reading the (already-gone) local row", async () => {
    const client = fakeClient({
      deltaContacts: vi.fn(async () => ({ contacts: [graphContact("c1")], deltaLink: "link-1" })),
    });
    const { book } = await mirrorOneContact(client);
    await enqueueMicrosoftContactWrite(db, {
      addressBookId: book.id,
      microsoftId: "c1",
      kind: "delete",
    });

    await drainMicrosoftContactWrites(db, client, book, "at");

    expect(client.deleteContact).toHaveBeenCalledWith("at", "c1");
    const remaining = await db.select().from(microsoftContactWrites);
    expect(remaining).toHaveLength(0);
  });
});

describe("a synced-down photo (#227, into #213's own Blob Store)", () => {
  it("stores a recognised content type through putContactPhoto", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const bytes = Buffer.from([1, 2, 3, 4]);
    const client = fakeClient({
      deltaContacts: vi.fn(async () => ({ contacts: [graphContact("c1")], deltaLink: "link-1" })),
      getContactPhoto: vi.fn(async () => ({
        contentType: "image/jpeg",
        base64: bytes.toString("base64"),
      })),
    });

    await syncMicrosoftContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    const book = await theAddressBook(connectedAccountId);
    const [row] = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(row?.photo?.mimeType).toBe("image/jpeg");
  });

  it("skips a content type the Blob Store doesn't recognise, without failing the Contact upsert", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client = fakeClient({
      deltaContacts: vi.fn(async () => ({ contacts: [graphContact("c1")], deltaLink: "link-1" })),
      getContactPhoto: vi.fn(async () => ({ contentType: "image/bmp", base64: "AA==" })),
    });

    await syncMicrosoftContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    const book = await theAddressBook(connectedAccountId);
    const [row] = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(row?.microsoftId).toBe("c1");
    expect(row?.photo).toBeNull();
  });

  it("tolerates a failed photo fetch, without failing the Contact upsert", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const client = fakeClient({
      deltaContacts: vi.fn(async () => ({ contacts: [graphContact("c1")], deltaLink: "link-1" })),
      getContactPhoto: vi.fn(async () => {
        throw new Error("simulated network failure");
      }),
    });

    await syncMicrosoftContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    const book = await theAddressBook(connectedAccountId);
    const [row] = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(row?.microsoftId).toBe("c1");
  });
});

describe("an unmirrored Address Book (#208)", () => {
  it("is skipped by the sync tick: no delta round, no write-back drain", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const first = fakeClient({
      deltaContacts: vi.fn(async () => ({ contacts: [graphContact("c1")], deltaLink: "link-1" })),
    });
    await syncMicrosoftContactsForAccount(db, first, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });
    const book = await theAddressBook(connectedAccountId);
    await unmirrorAddressBook(db, userId, book.id);

    const client = fakeClient();
    await syncMicrosoftContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    expect(client.deltaContacts).not.toHaveBeenCalled();
    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(rows).toHaveLength(0);
  });

  it("resumes normal syncing on the next tick once re-mirrored", async () => {
    const { userId, connectedAccountId } = await setUpAccount();
    const first = fakeClient({
      deltaContacts: vi.fn(async () => ({ contacts: [graphContact("c1")], deltaLink: "link-1" })),
    });
    await syncMicrosoftContactsForAccount(db, first, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });
    const book = await theAddressBook(connectedAccountId);
    await unmirrorAddressBook(db, userId, book.id);
    await mirrorAddressBook(db, userId, book.id);

    const client = fakeClient({
      deltaContacts: vi.fn(async () => ({
        contacts: [graphContact("c1"), graphContact("c2")],
        deltaLink: "link-2",
      })),
    });
    await syncMicrosoftContactsForAccount(db, client, {
      userId,
      connectedAccountId,
      accessToken: "at",
    });

    expect(client.deltaContacts).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(contacts).where(eq(contacts.addressBookId, book.id));
    expect(rows.map((row) => row.microsoftId).sort()).toEqual(["c1", "c2"]);
  });
});
