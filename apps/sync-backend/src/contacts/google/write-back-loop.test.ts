import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureGoogleAddressBook } from "../../address-books/store.js";
import {
  deriveCredentialKey,
  widenOAuthCredential,
} from "../../connected-accounts/credential-crypto.js";
import {
  attachFacetToConnectedAccount,
  getConnectedAccountById,
} from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import {
  contactGoogleWriteBacks,
  contactPhotoBlobs,
  contactRollbacks,
  contacts,
} from "../../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../../test-support/db.js";
import { createTestMailAccount } from "../../test-support/mail-account.js";
import { upsertGoogleContact } from "../store.js";
import {
  enqueueContactDeleteWriteBack,
  enqueueContactFieldsWriteBack,
  enqueueContactPhotoWriteBack,
  enqueueContactRestoreWriteBack,
} from "../write-back-outbox.js";
import { GoogleContactWriteRejectedError, type GooglePeopleClient } from "./client.js";
import { GOOGLE_PERSON_FIELDS } from "./people-sync.js";
import { startGoogleContactsWriteBackLoop } from "./write-back-loop.js";

/**
 * The write-back outbox's own drain (#216): confirm, "upstream wins"
 * rollback and the sequential-per-Connected-Account discipline — this
 * ticket's own acceptance lines. `mapping.test.ts`/`client.test.ts` already
 * own the field-masking and wire-format details; this file's whole job is
 * the loop's own orchestration against a real test database.
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

async function setUpMirroredContact(payload: Record<string, unknown> & { etag: string }) {
  const account = await createTestMailAccount(db, { oauth: { accessToken: "mail-token" } });
  const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
  const before = await getConnectedAccountById(db, account.connectedAccountId);
  if (!before) throw new Error("expected the Connected Account to exist");
  const widened = widenOAuthCredential(
    before.credential,
    {
      provider: "google",
      accessToken: "contacts-access-token",
      refreshToken: "fresh-refresh",
      expiresAt: "2026-02-01T00:00:00.000Z",
      scope: ["https://www.googleapis.com/auth/contacts", "openid", "email"],
    },
    "default",
    account.connectedAccountId,
    key,
  );
  await attachFacetToConnectedAccount(db, account.connectedAccountId, "contacts", widened);

  const addressBook = await ensureGoogleAddressBook(db, {
    userId: account.userId,
    connectedAccountId: account.connectedAccountId,
  });
  const contactId = await upsertGoogleContact(db, {
    addressBookId: addressBook.id,
    userId: account.userId,
    connectedAccountId: account.connectedAccountId,
    resourceName: "people/c1",
    etag: payload.etag,
    payload,
  });
  return { ...account, contactId };
}

async function contactRow(contactId: string) {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!row) throw new Error("expected the Contact row to exist");
  return row;
}

function fakeClient(overrides: Partial<GooglePeopleClient> = {}): GooglePeopleClient {
  return {
    listConnections: vi.fn(),
    updateContact: vi.fn(),
    updateContactPhoto: vi.fn(),
    deleteContactPhoto: vi.fn(),
    createContact: vi.fn(),
    deleteContact: vi.fn(),
    ...overrides,
  };
}

describe("startGoogleContactsWriteBackLoop — fields", () => {
  it("confirms a successful write: adopts the response's etag/payload/fields and drains the outbox row", async () => {
    const { contactId } = await setUpMirroredContact({
      resourceName: "people/c1",
      etag: "etag-1",
      names: [{ givenName: "Ada" }],
    });
    // The optimistic edit already applied to the mirror row, the same way
    // `sync/mutations.ts#applyUserIntent`'s `updateContact` case leaves it —
    // `googleEtag`/`googlePayload` stay at their last-confirmed value.
    await db.update(contacts).set({ notes: "call back Tuesday" }).where(eq(contacts.id, contactId));
    await enqueueContactFieldsWriteBack(db, {
      contactId,
      connectedAccountId: (await contactRow(contactId)).connectedAccountId as string,
    });

    const responsePerson = {
      resourceName: "people/c1",
      etag: "etag-2",
      names: [{ givenName: "Ada" }],
      biographies: [{ value: "call back Tuesday" }],
    };
    const client = fakeClient({ updateContact: vi.fn().mockResolvedValue(responsePerson) });

    const handle = startGoogleContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactGoogleWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    expect(client.updateContact).toHaveBeenCalledWith(
      "contacts-access-token",
      expect.objectContaining({
        resourceName: "people/c1",
        personFields: GOOGLE_PERSON_FIELDS,
        body: expect.objectContaining({ etag: "etag-1" }),
      }),
    );
    const row = await contactRow(contactId);
    expect(row.googleEtag).toBe("etag-2");
    expect(row.notes).toBe("call back Tuesday");
    expect(await db.select().from(contactRollbacks)).toEqual([]);
  });

  it('reverts the mirror to the last-confirmed Google state and records a "google_conflict" rollback on a rejected write', async () => {
    const { contactId } = await setUpMirroredContact({
      resourceName: "people/c1",
      etag: "etag-1",
      names: [{ givenName: "Ada" }],
      biographies: [{ value: "original note" }],
    });
    await db.update(contacts).set({ notes: "conflicting edit" }).where(eq(contacts.id, contactId));
    await enqueueContactFieldsWriteBack(db, {
      contactId,
      connectedAccountId: (await contactRow(contactId)).connectedAccountId as string,
    });

    const client = fakeClient({
      updateContact: vi.fn().mockRejectedValue(
        new GoogleContactWriteRejectedError(400, {
          error: { status: "FAILED_PRECONDITION" },
        }),
      ),
    });

    const handle = startGoogleContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactGoogleWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    const row = await contactRow(contactId);
    expect(row.notes).toBe("original note");
    expect(row.googleEtag).toBe("etag-1"); // never touched Google — nothing to roll back on the token itself

    const [rollback] = await db.select().from(contactRollbacks);
    expect(rollback).toMatchObject({ contactId, reason: "google_conflict" });
  });

  it("leaves a row queued (never rolls back) on a transient failure — retried on the next tick instead", async () => {
    const { contactId } = await setUpMirroredContact({ resourceName: "people/c1", etag: "etag-1" });
    await enqueueContactFieldsWriteBack(db, {
      contactId,
      connectedAccountId: (await contactRow(contactId)).connectedAccountId as string,
    });

    let calls = 0;
    const client = fakeClient({
      updateContact: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated network failure");
        return { resourceName: "people/c1", etag: "etag-2" };
      }),
    });

    const handle = startGoogleContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 10,
    });
    await vi.waitFor(async () => {
      expect(calls).toBeGreaterThanOrEqual(2);
    });
    await handle.stop();

    expect(await db.select().from(contactRollbacks)).toEqual([]);
  });

  it("drains one Connected Account's queue sequentially — never two writes in flight at once", async () => {
    const {
      userId,
      connectedAccountId,
      contactId: firstContactId,
    } = await setUpMirroredContact({ resourceName: "people/c1", etag: "etag-1" });
    const addressBook = await ensureGoogleAddressBook(db, { userId, connectedAccountId });
    const secondContactId = await upsertGoogleContact(db, {
      addressBookId: addressBook.id,
      userId,
      connectedAccountId,
      resourceName: "people/c2",
      etag: "etag-1",
      payload: { resourceName: "people/c2", etag: "etag-1" },
    });
    await enqueueContactFieldsWriteBack(db, { contactId: firstContactId, connectedAccountId });
    await enqueueContactFieldsWriteBack(db, { contactId: secondContactId, connectedAccountId });

    let inFlight = 0;
    let maxConcurrent = 0;
    const client = fakeClient({
      updateContact: vi.fn(async (_token, params) => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { resourceName: params.resourceName, etag: "etag-2" };
      }),
    });

    const handle = startGoogleContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactGoogleWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    expect(client.updateContact).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);
  });
});

describe("startGoogleContactsWriteBackLoop — photo", () => {
  it("uploads the current photo's bytes via updateContactPhoto on success", async () => {
    const { contactId } = await setUpMirroredContact({ resourceName: "people/c1", etag: "etag-1" });
    await db
      .insert(contactPhotoBlobs)
      .values({ id: "blob-1", mimeType: "image/png", bytes: Buffer.from("hi") });
    await db
      .update(contacts)
      .set({ photo: { blobId: "blob-1", mimeType: "image/png" } })
      .where(eq(contacts.id, contactId));
    await enqueueContactPhotoWriteBack(db, {
      contactId,
      connectedAccountId: (await contactRow(contactId)).connectedAccountId as string,
      previousPhoto: null,
    });

    const client = fakeClient({ updateContactPhoto: vi.fn().mockResolvedValue(undefined) });
    const handle = startGoogleContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactGoogleWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    expect(client.updateContactPhoto).toHaveBeenCalledWith(
      "contacts-access-token",
      "people/c1",
      Buffer.from("hi").toString("base64"),
    );
  });

  it("reverts to the pre-edit photo snapshot and records a rollback on a rejected photo write", async () => {
    const { contactId } = await setUpMirroredContact({ resourceName: "people/c1", etag: "etag-1" });
    await db
      .insert(contactPhotoBlobs)
      .values({ id: "new-blob", mimeType: "image/png", bytes: Buffer.from("new") });
    await db
      .update(contacts)
      .set({ photo: { blobId: "new-blob", mimeType: "image/png" } })
      .where(eq(contacts.id, contactId));
    await enqueueContactPhotoWriteBack(db, {
      contactId,
      connectedAccountId: (await contactRow(contactId)).connectedAccountId as string,
      previousPhoto: { blobId: "old-blob", mimeType: "image/jpeg" },
    });

    const client = fakeClient({
      deleteContactPhoto: vi.fn().mockRejectedValue(new GoogleContactWriteRejectedError(403, {})),
      updateContactPhoto: vi.fn().mockRejectedValue(new GoogleContactWriteRejectedError(403, {})),
    });
    const handle = startGoogleContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactGoogleWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    const row = await contactRow(contactId);
    expect(row.photo).toEqual({ blobId: "old-blob", mimeType: "image/jpeg" });
    const [rollback] = await db.select().from(contactRollbacks);
    expect(rollback).toMatchObject({ contactId, reason: "google_rejected" });
  });
});

describe("startGoogleContactsWriteBackLoop — delete / restore (#224)", () => {
  it("removes Google's copy by the resourceName captured at enqueue time", async () => {
    const { contactId } = await setUpMirroredContact({ resourceName: "people/c1", etag: "etag-1" });
    const connectedAccountId = (await contactRow(contactId)).connectedAccountId as string;
    // `trashContactAndLinkedGroup`'s own write: the row's own copy is
    // already cleared by the time this drains (ADR-0029).
    await db
      .update(contacts)
      .set({ googleResourceName: null, googleEtag: null, googlePayload: null })
      .where(eq(contacts.id, contactId));
    await enqueueContactDeleteWriteBack(db, {
      contactId,
      connectedAccountId,
      googleResourceName: "people/c1",
    });

    const client = fakeClient({ deleteContact: vi.fn().mockResolvedValue(undefined) });
    const handle = startGoogleContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactGoogleWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    expect(client.deleteContact).toHaveBeenCalledWith("contacts-access-token", "people/c1");
    expect(await db.select().from(contactRollbacks)).toEqual([]);
  });

  it("treats a rejected delete (already gone upstream) as nothing left to do — no rollback, row still dequeues", async () => {
    const { contactId } = await setUpMirroredContact({ resourceName: "people/c1", etag: "etag-1" });
    const connectedAccountId = (await contactRow(contactId)).connectedAccountId as string;
    await enqueueContactDeleteWriteBack(db, {
      contactId,
      connectedAccountId,
      googleResourceName: "people/c1",
    });

    const client = fakeClient({
      deleteContact: vi.fn().mockRejectedValue(new GoogleContactWriteRejectedError(404, {})),
    });
    const handle = startGoogleContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactGoogleWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    expect(await db.select().from(contactRollbacks)).toEqual([]);
  });

  it("restores by creating a brand-new upstream Person and stamping its fresh resourceName/etag onto the same Wicket row", async () => {
    const { contactId } = await setUpMirroredContact({ resourceName: "people/c1", etag: "etag-1" });
    const connectedAccountId = (await contactRow(contactId)).connectedAccountId as string;
    // The trash-time clear this always follows (ADR-0029) — there is
    // nothing left to reactivate, only a fresh create.
    await db
      .update(contacts)
      .set({ googleResourceName: null, googleEtag: null, googlePayload: null, notes: "call back" })
      .where(eq(contacts.id, contactId));
    await enqueueContactRestoreWriteBack(db, { contactId, connectedAccountId });

    const createdPerson = {
      resourceName: "people/c2",
      etag: "etag-new",
      names: [{ givenName: "Ada" }],
      biographies: [{ value: "call back" }],
    };
    const client = fakeClient({ createContact: vi.fn().mockResolvedValue(createdPerson) });
    const handle = startGoogleContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactGoogleWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    expect(client.createContact).toHaveBeenCalledWith(
      "contacts-access-token",
      expect.objectContaining({ personFields: GOOGLE_PERSON_FIELDS }),
    );
    const row = await contactRow(contactId);
    expect(row.googleResourceName).toBe("people/c2");
    expect(row.googleEtag).toBe("etag-new");
    expect(row.notes).toBe("call back");
  });

  it("skips the create outright when the Contact already has a resourceName (a race already gave it one)", async () => {
    const { contactId } = await setUpMirroredContact({ resourceName: "people/c1", etag: "etag-1" });
    const connectedAccountId = (await contactRow(contactId)).connectedAccountId as string;
    await enqueueContactRestoreWriteBack(db, { contactId, connectedAccountId });

    const client = fakeClient({ createContact: vi.fn() });
    const handle = startGoogleContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactGoogleWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    expect(client.createContact).not.toHaveBeenCalled();
  });

  it("dequeues a definitively rejected restore create rather than retrying it forever", async () => {
    const { contactId } = await setUpMirroredContact({ resourceName: "people/c1", etag: "etag-1" });
    const connectedAccountId = (await contactRow(contactId)).connectedAccountId as string;
    await db
      .update(contacts)
      .set({ googleResourceName: null, googleEtag: null, googlePayload: null })
      .where(eq(contacts.id, contactId));
    await enqueueContactRestoreWriteBack(db, { contactId, connectedAccountId });

    const client = fakeClient({
      createContact: vi.fn().mockRejectedValue(new GoogleContactWriteRejectedError(400, {})),
    });
    const handle = startGoogleContactsWriteBackLoop(db, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      client,
      intervalMs: 60_000,
    });
    await vi.waitFor(async () => {
      expect(await db.select().from(contactGoogleWriteBacks)).toHaveLength(0);
    });
    await handle.stop();

    const row = await contactRow(contactId);
    expect(row.googleResourceName).toBeNull();
  });
});
