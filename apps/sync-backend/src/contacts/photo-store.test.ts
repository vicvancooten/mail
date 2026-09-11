import { randomUUID } from "node:crypto";
import { EMPTY_CONTACT_FIELDS, generateUlid } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ensureGoogleAddressBook, ensureLocalAddressBookId } from "../address-books/store.js";
import type { Db } from "../db/client.js";
import { contactGoogleWriteBacks, contactPhotoBlobs, users } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  collectOrphanedBlob,
  getContactPhotoBlob,
  putContactPhoto,
  removeContactPhoto,
  sweepOrphanedContactPhotoBlobs,
} from "./photo-store.js";
import { insertContact, upsertGoogleContact } from "./store.js";

/**
 * The store-level half of #213's own "orphaned blobs are collectable"
 * acceptance line — `contact-photos.test.ts` covers the HTTP surface these
 * calls sit behind.
 */

let db: Db;
let closeDb: () => Promise<void>;

async function createTestUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      username: `vic-${randomUUID().slice(0, 8)}`,
      passwordHash: "not-checked-in-these-tests",
      role: "owner",
    })
    .returning();
  if (!user) throw new Error("insert returned no row");
  return user.id;
}

async function makeContact(userId: string): Promise<string> {
  const addressBookId = await ensureLocalAddressBookId(db, userId);
  const contactId = generateUlid();
  await insertContact(db, userId, addressBookId, contactId, EMPTY_CONTACT_FIELDS);
  return contactId;
}

/** A Google-mirrored Contact — `makeContact`'s sibling for #216's own write-back enqueue tests below. */
async function makeMirroredContact(): Promise<{ contactId: string; connectedAccountId: string }> {
  const account = await createTestMailAccount(db);
  const addressBook = await ensureGoogleAddressBook(db, {
    userId: account.userId,
    connectedAccountId: account.connectedAccountId,
  });
  const contactId = await upsertGoogleContact(db, {
    addressBookId: addressBook.id,
    userId: account.userId,
    connectedAccountId: account.connectedAccountId,
    resourceName: "people/c1",
    etag: "etag-1",
    payload: { resourceName: "people/c1", etag: "etag-1" },
  });
  return { contactId, connectedAccountId: account.connectedAccountId };
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

describe("putContactPhoto", () => {
  it("two Contacts uploading the same bytes share one blob row", async () => {
    const userId = await createTestUser();
    const a = await makeContact(userId);
    const b = await makeContact(userId);
    const bytes = Buffer.from("shared image bytes");

    const first = await putContactPhoto(db, {
      userId,
      contactId: a,
      bytes,
      mimeType: "image/png",
      maxBytes: 1024,
    });
    const second = await putContactPhoto(db, {
      userId,
      contactId: b,
      bytes,
      mimeType: "image/png",
      maxBytes: 1024,
    });

    expect(first.ok && second.ok && first.photo.blobId).toBe(second.ok && second.photo.blobId);
    const rows = await db
      .select()
      .from(contactPhotoBlobs)
      .where(eq(contactPhotoBlobs.id, first.ok ? first.photo.blobId : ""));
    expect(rows).toHaveLength(1);
  });

  it("replacing a Contact's own photo collects the previous blob once nothing else names it", async () => {
    const userId = await createTestUser();
    const contactId = await makeContact(userId);

    const first = await putContactPhoto(db, {
      userId,
      contactId,
      bytes: Buffer.from("first image"),
      mimeType: "image/png",
      maxBytes: 1024,
    });
    if (!first.ok) throw new Error("expected first upload to succeed");

    await putContactPhoto(db, {
      userId,
      contactId,
      bytes: Buffer.from("second image"),
      mimeType: "image/png",
      maxBytes: 1024,
    });

    const remaining = await db
      .select()
      .from(contactPhotoBlobs)
      .where(eq(contactPhotoBlobs.id, first.photo.blobId));
    expect(remaining).toHaveLength(0);
  });

  it("never collects a blob still shared by another Contact", async () => {
    const userId = await createTestUser();
    const a = await makeContact(userId);
    const b = await makeContact(userId);
    const shared = Buffer.from("shared image bytes");

    const first = await putContactPhoto(db, {
      userId,
      contactId: a,
      bytes: shared,
      mimeType: "image/png",
      maxBytes: 1024,
    });
    await putContactPhoto(db, {
      userId,
      contactId: b,
      bytes: shared,
      mimeType: "image/png",
      maxBytes: 1024,
    });
    if (!first.ok) throw new Error("expected first upload to succeed");

    // Contact A moves on to a new photo — the shared blob must survive since
    // Contact B still names it.
    await putContactPhoto(db, {
      userId,
      contactId: a,
      bytes: Buffer.from("a's new image"),
      mimeType: "image/png",
      maxBytes: 1024,
    });

    const stillThere = await db
      .select()
      .from(contactPhotoBlobs)
      .where(eq(contactPhotoBlobs.id, first.photo.blobId));
    expect(stillThere).toHaveLength(1);
  });

  it("rejects a Contact this User does not own", async () => {
    const userId = await createTestUser();
    const result = await putContactPhoto(db, {
      userId,
      contactId: "not-mine",
      bytes: Buffer.from("x"),
      mimeType: "image/png",
      maxBytes: 1024,
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects bytes over the given budget", async () => {
    const userId = await createTestUser();
    const contactId = await makeContact(userId);
    const result = await putContactPhoto(db, {
      userId,
      contactId,
      bytes: Buffer.alloc(100),
      mimeType: "image/png",
      maxBytes: 10,
    });
    expect(result).toEqual({ ok: false, reason: "over_budget", maxBytes: 10 });
  });
});

describe("removeContactPhoto", () => {
  it("clears the reference and collects the now-orphaned blob", async () => {
    const userId = await createTestUser();
    const contactId = await makeContact(userId);
    const put = await putContactPhoto(db, {
      userId,
      contactId,
      bytes: Buffer.from("an image"),
      mimeType: "image/png",
      maxBytes: 1024,
    });
    if (!put.ok) throw new Error("expected upload to succeed");

    const result = await removeContactPhoto(db, userId, contactId);
    expect(result).toEqual({ status: "removed" });

    const blob = await getContactPhotoBlob(db, userId, contactId);
    expect(blob).toBeNull();
    const rows = await db
      .select()
      .from(contactPhotoBlobs)
      .where(eq(contactPhotoBlobs.id, put.photo.blobId));
    expect(rows).toHaveLength(0);
  });

  it("404s (not_found) for a Contact this User does not own", async () => {
    const userId = await createTestUser();
    const result = await removeContactPhoto(db, userId, "not-mine");
    expect(result).toEqual({ status: "not_found" });
  });

  it("is a no-op success removing an already-photo-less Contact", async () => {
    const userId = await createTestUser();
    const contactId = await makeContact(userId);
    const result = await removeContactPhoto(db, userId, contactId);
    expect(result).toEqual({ status: "removed" });
  });
});

describe("collectOrphanedBlob / sweepOrphanedContactPhotoBlobs", () => {
  it("sweeps every blob no Contact currently references", async () => {
    const userId = await createTestUser();
    const contactId = await makeContact(userId);
    const kept = await putContactPhoto(db, {
      userId,
      contactId,
      bytes: Buffer.from("kept"),
      mimeType: "image/png",
      maxBytes: 1024,
    });
    if (!kept.ok) throw new Error("expected upload to succeed");

    // A blob inserted directly, bypassing `putContactPhoto`, so nothing
    // references it — the class of orphan a crashed request between the
    // blob insert and the Contact update could otherwise leave behind.
    await db.insert(contactPhotoBlobs).values({
      id: "orphan-hash",
      mimeType: "image/png",
      bytes: Buffer.from("nobody points at this"),
    });

    const collected = await sweepOrphanedContactPhotoBlobs(db);
    expect(collected).toBe(1);

    const remainingIds = (
      await db.select({ id: contactPhotoBlobs.id }).from(contactPhotoBlobs)
    ).map((row) => row.id);
    expect(remainingIds).toEqual([kept.photo.blobId]);
  });

  it("collectOrphanedBlob leaves a referenced blob alone", async () => {
    const userId = await createTestUser();
    const contactId = await makeContact(userId);
    const put = await putContactPhoto(db, {
      userId,
      contactId,
      bytes: Buffer.from("still referenced"),
      mimeType: "image/png",
      maxBytes: 1024,
    });
    if (!put.ok) throw new Error("expected upload to succeed");

    await collectOrphanedBlob(db, put.photo.blobId);

    const rows = await db
      .select()
      .from(contactPhotoBlobs)
      .where(eq(contactPhotoBlobs.id, put.photo.blobId));
    expect(rows).toHaveLength(1);
  });
});

/**
 * The write-back outbox enqueue (#216): `updateContactPhoto`, a
 * categorically separate call from the field write — this ticket's own
 * acceptance line. `google/write-back-loop.test.ts` owns the drain itself;
 * this only proves `putContactPhoto`/`removeContactPhoto` queue the right
 * row (or none, for a Local Contact) with the right `previousPhoto`.
 */
describe("photo write-back enqueue", () => {
  async function writeBacksFor(contactId: string) {
    return db
      .select()
      .from(contactGoogleWriteBacks)
      .where(eq(contactGoogleWriteBacks.contactId, contactId));
  }

  it("never enqueues a write-back for a Local Contact's photo upload", async () => {
    const userId = await createTestUser();
    const contactId = await makeContact(userId);

    await putContactPhoto(db, {
      userId,
      contactId,
      bytes: Buffer.from("a"),
      mimeType: "image/png",
      maxBytes: 1024,
    });

    expect(await writeBacksFor(contactId)).toEqual([]);
  });

  it('enqueues a "photo" write-back with previousPhoto null on a mirrored Contact\'s first upload', async () => {
    const { contactId, connectedAccountId } = await makeMirroredContact();

    await putContactPhoto(db, {
      userId: (await db.select().from(users))[0]?.id as string,
      contactId,
      bytes: Buffer.from("a"),
      mimeType: "image/png",
      maxBytes: 1024,
    });

    const writeBacks = await writeBacksFor(contactId);
    expect(writeBacks).toMatchObject([
      { contactId, connectedAccountId, kind: "photo", previousPhoto: null },
    ]);
  });

  it("keeps the first upload's previousPhoto snapshot across a second upload before the first drains", async () => {
    const { contactId } = await makeMirroredContact();
    const userId = (await db.select().from(users))[0]?.id as string;

    await putContactPhoto(db, {
      userId,
      contactId,
      bytes: Buffer.from("first"),
      mimeType: "image/png",
      maxBytes: 1024,
    });
    await putContactPhoto(db, {
      userId,
      contactId,
      bytes: Buffer.from("second"),
      mimeType: "image/png",
      maxBytes: 1024,
    });

    const writeBacks = await writeBacksFor(contactId);
    expect(writeBacks).toHaveLength(1);
    expect(writeBacks[0]?.previousPhoto).toBeNull();
  });

  it('enqueues a "photo" write-back naming the removed photo as previousPhoto on removeContactPhoto', async () => {
    const { contactId } = await makeMirroredContact();
    const userId = (await db.select().from(users))[0]?.id as string;
    const put = await putContactPhoto(db, {
      userId,
      contactId,
      bytes: Buffer.from("a"),
      mimeType: "image/png",
      maxBytes: 1024,
    });
    if (!put.ok) throw new Error("expected upload to succeed");
    // The upload's own write-back is still pending — drop it so this test
    // only asserts on `removeContactPhoto`'s own enqueue.
    await db.delete(contactGoogleWriteBacks);

    await removeContactPhoto(db, userId, contactId);

    const writeBacks = await writeBacksFor(contactId);
    expect(writeBacks).toMatchObject([{ kind: "photo", previousPhoto: put.photo }]);
  });
});
