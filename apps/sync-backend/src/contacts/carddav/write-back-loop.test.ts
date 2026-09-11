import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureCarddavAddressBook } from "../../address-books/store.js";
import {
  deriveCredentialKey,
  sealPasswordCredential,
} from "../../connected-accounts/credential-crypto.js";
import { insertCalDavAccount } from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { contactCarddavWriteBacks, contactRollbacks, contacts, users } from "../../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../../test-support/db.js";
import { upsertCarddavContact } from "../store.js";
import {
  enqueueContactCarddavDeleteWriteBack,
  enqueueContactCarddavFieldsWriteBack,
  enqueueContactCarddavPhotoWriteBack,
  enqueueContactCarddavRestoreWriteBack,
} from "../write-back-outbox.js";
import { type CarddavClient, CarddavWriteRejectedError } from "./client.js";
import { startCarddavContactsWriteBackLoop } from "./write-back-loop.js";

/**
 * The write-back outbox's own drain (#226): confirm, "upstream wins"
 * rollback and the sequential-per-collection discipline — this ticket's own
 * acceptance lines. `vcard.test.ts` already owns the parse/serialize
 * details; this file's whole job is the loop's own orchestration against a
 * real test database, `contacts/google/write-back-loop.test.ts`'s own shape.
 */

const COLLECTION_URL = "https://carddav.example.com/addressbooks/ada/default/";

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

async function setUpMirroredContact(args: {
  href: string;
  etag: string;
  uid: string;
  given: string;
  notes?: string;
}) {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    username: `user-${userId.slice(0, 8)}`,
    passwordHash: "not-a-real-hash",
    role: "owner",
  });
  const connectedAccountId = randomUUID();
  const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
  await insertCalDavAccount(db, {
    id: connectedAccountId,
    userId,
    serverAddress: "carddav.example.com",
    username: "ada",
    credential: sealPasswordCredential("app-password", connectedAccountId, key),
    facet: "contacts",
    discovery: {
      principalUrl: "https://carddav.example.com/principals/ada/",
      homeSetUrl: "https://carddav.example.com/addressbooks/ada/",
      supportsScheduling: false,
    },
  });
  const addressBook = await ensureCarddavAddressBook(db, {
    userId,
    connectedAccountId,
    collectionUrl: COLLECTION_URL,
    name: "Default",
  });
  const rawVcard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${args.uid}`,
    `FN:${args.given}`,
    `N:;${args.given};;;`,
    args.notes ? `NOTE:${args.notes}` : undefined,
    "GEO:51.5;-0.1",
    "END:VCARD",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\r\n");
  const contactId = await upsertCarddavContact(db, {
    addressBookId: addressBook.id,
    userId,
    connectedAccountId,
    href: `${COLLECTION_URL}${args.href}`,
    etag: args.etag,
    rawVcard,
    fields: {
      name: { given: args.given },
      emails: [],
      phones: [],
      addresses: [],
      websites: [],
      organizations: [],
      birthday: null,
      notes: args.notes ?? "",
      customFields: [],
    },
    categories: [],
  });
  return { userId, connectedAccountId, addressBookId: addressBook.id, contactId };
}

async function contactRow(contactId: string) {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!row) throw new Error("expected the Contact row to exist");
  return row;
}

function fakeClient(overrides: Partial<CarddavClient> = {}): CarddavClient {
  return {
    fetchAddressBooks: vi.fn(async () => []),
    fetchCtag: vi.fn(async () => undefined),
    syncCollection: vi.fn(async () => ({
      changed: [],
      deletedHrefs: [],
      nextSyncToken: undefined,
    })),
    listHrefs: vi.fn(async () => []),
    multiget: vi.fn(async () => []),
    createVCard: vi.fn(async () => ({ href: "unused", etag: undefined })),
    updateVCard: vi.fn(async () => ({ etag: undefined })),
    deleteVCard: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("startCarddavContactsWriteBackLoop — fields/photo", () => {
  it("confirms a successful update: chains the etag/raw vCard and drains the outbox row", async () => {
    const { contactId } = await setUpMirroredContact({
      href: "ada.vcf",
      etag: "etag-1",
      uid: "uid-1",
      given: "Ada",
    });
    await db.update(contacts).set({ notes: "call back Tuesday" }).where(eq(contacts.id, contactId));
    await enqueueContactCarddavFieldsWriteBack(db, {
      contactId,
      addressBookId: (await contactRow(contactId)).addressBookId,
    });

    const client = fakeClient({
      updateVCard: vi.fn(async () => ({ etag: "etag-2" })),
      multiget: vi.fn(async () => [
        {
          href: `${COLLECTION_URL}ada.vcf`,
          etag: "etag-2",
          data: "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:uid-1\r\nFN:Ada\r\nN:;Ada;;;\r\nNOTE:call back Tuesday\r\nGEO:51.5;-0.1\r\nEND:VCARD",
        },
      ]),
    });

    const handle = startCarddavContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactCarddavWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    expect(client.updateVCard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${COLLECTION_URL}ada.vcf`,
        etag: "etag-1",
        data: expect.stringContaining("GEO:51.5;-0.1"), // an unmodelled line survives the write
      }),
    );
    const row = await contactRow(contactId);
    expect(row.carddavEtag).toBe("etag-2");
    expect(row.notes).toBe("call back Tuesday");
    expect(row.carddavRawVcard).toContain("GEO:51.5;-0.1");
    expect(await db.select().from(contactRollbacks)).toEqual([]);
  });

  it('reverts the mirror and records a "carddav_conflict" rollback on a 412', async () => {
    const { contactId } = await setUpMirroredContact({
      href: "ada.vcf",
      etag: "etag-1",
      uid: "uid-1",
      given: "Ada",
      notes: "original note",
    });
    await db.update(contacts).set({ notes: "conflicting edit" }).where(eq(contacts.id, contactId));
    await enqueueContactCarddavFieldsWriteBack(db, {
      contactId,
      addressBookId: (await contactRow(contactId)).addressBookId,
    });

    const client = fakeClient({
      updateVCard: vi.fn(async () => {
        throw new CarddavWriteRejectedError(412, "Precondition Failed");
      }),
    });

    const handle = startCarddavContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactCarddavWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    const row = await contactRow(contactId);
    expect(row.notes).toBe("original note");
    const rollbacks = await db.select().from(contactRollbacks);
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0]?.reason).toBe("carddav_conflict");
  });

  it("reverts just the photo (not the fields) and records a rollback on a rejected photo write", async () => {
    const { contactId } = await setUpMirroredContact({
      href: "ada.vcf",
      etag: "etag-1",
      uid: "uid-1",
      given: "Ada",
    });
    await db
      .update(contacts)
      .set({ photo: { blobId: "new-blob", mimeType: "image/jpeg" }, notes: "kept" })
      .where(eq(contacts.id, contactId));
    await enqueueContactCarddavPhotoWriteBack(db, {
      contactId,
      addressBookId: (await contactRow(contactId)).addressBookId,
      previousPhoto: null,
    });

    const client = fakeClient({
      updateVCard: vi.fn(async () => {
        throw new CarddavWriteRejectedError(404, "Not Found");
      }),
    });

    const handle = startCarddavContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactCarddavWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    const row = await contactRow(contactId);
    expect(row.photo).toBeNull();
    expect(row.notes).toBe("kept"); // the field edit this row never concerned survives
    const rollbacks = await db.select().from(contactRollbacks);
    expect(rollbacks[0]?.reason).toBe("carddav_not_found");
  });
});

describe("startCarddavContactsWriteBackLoop — delete/restore", () => {
  it("deletes the vCard by its captured href and drains the row", async () => {
    const { contactId, addressBookId } = await setUpMirroredContact({
      href: "ada.vcf",
      etag: "etag-1",
      uid: "uid-1",
      given: "Ada",
    });
    await enqueueContactCarddavDeleteWriteBack(db, {
      contactId,
      addressBookId,
      carddavHref: `${COLLECTION_URL}ada.vcf`,
    });

    const client = fakeClient({ deleteVCard: vi.fn(async () => undefined) });
    const handle = startCarddavContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactCarddavWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    expect(client.deleteVCard).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${COLLECTION_URL}ada.vcf` }),
    );
  });

  it("creates a fresh vCard for a restored Contact and confirms its new href/etag", async () => {
    const { contactId, addressBookId } = await setUpMirroredContact({
      href: "ada.vcf",
      etag: "etag-1",
      uid: "uid-1",
      given: "Ada",
    });
    // `trashContactAndLinkedGroup` clears the mirror identity before
    // queuing a restore — matching that here directly.
    await db
      .update(contacts)
      .set({ carddavHref: null, carddavEtag: null, carddavRawVcard: null })
      .where(eq(contacts.id, contactId));
    await enqueueContactCarddavRestoreWriteBack(db, { contactId, addressBookId });

    const client = fakeClient({
      createVCard: vi.fn(async () => ({
        href: `${COLLECTION_URL}${contactId}.vcf`,
        etag: "etag-new",
      })),
      multiget: vi.fn(async () => [
        {
          href: `${COLLECTION_URL}${contactId}.vcf`,
          etag: "etag-new",
          data: `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${contactId}\r\nFN:Ada\r\nN:;Ada;;;\r\nEND:VCARD`,
        },
      ]),
    });
    const handle = startCarddavContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactCarddavWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    const row = await contactRow(contactId);
    expect(row.carddavHref).toBe(`${COLLECTION_URL}${contactId}.vcf`);
    expect(row.carddavEtag).toBe("etag-new");
  });
});
