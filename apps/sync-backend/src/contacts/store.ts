import type { Contact, ContactWritableFields } from "@mail/shared";
import { generateUlid } from "@mail/shared";
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { addressBookCapabilityTableId } from "../address-books/store.js";
import type { Db, Tx } from "../db/client.js";
import { contacts, microsoftContactWrites } from "../db/schema.js";
import { recordTombstones } from "../sync/tombstones.js";
import { parseVcard } from "./carddav/vcard.js";
import { googlePersonToContactFields } from "./google/mapping.js";
import { contactLinkMembersFor, pruneContactLinkMembers } from "./link-store.js";
import {
  enqueueContactCarddavDeleteWriteBack,
  enqueueContactCarddavRestoreWriteBack,
  enqueueContactDeleteWriteBack,
  enqueueContactRestoreWriteBack,
} from "./write-back-outbox.js";

export type MicrosoftContactWriteRow = typeof microsoftContactWrites.$inferSelect;

export type ContactRow = typeof contacts.$inferSelect;

/** Local Contacts only (`connectedAccountId is null`) — `address-books/store.ts#selectAddressBooksForUser`'s sibling for this collection. */
export function selectContactsForUser(db: Db, userId: string, cursorRev: number) {
  return db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        isNull(contacts.connectedAccountId),
        gt(contacts.syncRev, cursorRev),
      ),
    )
    .orderBy(asc(contacts.syncRev));
}

/** Every Contact mirrored into one Connected Account's Address Books — empty until an upstream adapter creates one (#214+). */
export function selectContactsForConnectedAccount(
  db: Db,
  connectedAccountId: string,
  cursorRev: number,
) {
  return db
    .select()
    .from(contacts)
    .where(
      and(eq(contacts.connectedAccountId, connectedAccountId), gt(contacts.syncRev, cursorRev)),
    )
    .orderBy(asc(contacts.syncRev));
}

/** One Contact this User owns (Local or mirrored), for `sync/mutations.ts`'s own intent handlers to check ownership against before writing. Accepts a `Tx` too — `merge-store.ts#mergeContacts` reads both sides inside its own transaction. */
export async function contactRowForUser(
  db: Db | Tx,
  userId: string,
  contactId: string,
): Promise<ContactRow | null> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * One Contact by id alone, no ownership check — a write-back loop's own
 * read: `google/write-back-loop.ts` and
 * `contacts-sync.ts#drainMicrosoftContactWrites` both already know this
 * row's owning User from the Connected Account they drained
 * (`listActiveConnectedAccountsWithFacet`), so there is no ownership check
 * left to make the way every User-facing route's own `contactRowForUser`
 * still needs one.
 */
export async function contactRowById(db: Db, contactId: string): Promise<ContactRow | null> {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  return row ?? null;
}

/**
 * Inserts a new Contact (`createContact`, ADR-0019's own inverse of
 * `deleteContact`) — `onConflictDoNothing` the same "retried id after a
 * dropped response" tolerance `sync/mutations.ts#applyUserIntent`'s
 * `createNote` case already has. `connectedAccountId` (#225) is the target
 * Address Book's own — `null` for a Local target, matching this function's
 * original Local-only shape — so a Contact created straight into a mirrored
 * Address Book (Copy/Import's own "ordinary create", `sync.ts`'s own doc
 * comment) rides the same Sync Scope every other Contact of that book does,
 * rather than landing in the User's own scope by mistake.
 */
export async function insertContact(
  db: Db,
  userId: string,
  addressBookId: string,
  contactId: string,
  fields: ContactWritableFields,
  connectedAccountId: string | null = null,
): Promise<void> {
  await db
    .insert(contacts)
    .values({
      id: contactId,
      addressBookId,
      userId,
      connectedAccountId,
      ...fields,
      labelIds: [],
    })
    .onConflictDoNothing({ target: contacts.id });
}

/** Whole-replaces every writable field (`updateContact`) — never a per-family patch, see `@mail/shared#contactWritableFieldsSchema`'s own doc comment. Accepts a `Tx` too — `merge-store.ts#mergeContacts` writes the survivor's merged fields inside its own transaction. */
export async function updateContactFields(
  db: Db | Tx,
  contactId: string,
  fields: ContactWritableFields,
): Promise<void> {
  await db
    .update(contacts)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}

export async function updateContactLabelIds(
  db: Db,
  contactId: string,
  labelIds: string[],
): Promise<void> {
  await db
    .update(contacts)
    .set({ labelIds, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}

/** `setContactBanner`'s own write (#212) — `updateContactLabelIds`'s own shape: a Wicket-only decoration on any Contact regardless of Origin, never gated by `LOCAL_CONTACT_CAPABILITY_TABLE` the way `updateContactFields` is. */
export async function updateContactBanner(
  db: Db,
  contactId: string,
  banner: Contact["banner"],
): Promise<void> {
  await db
    .update(contacts)
    .set({ banner, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}

/** `applyLabel`'s own `array_append` shape (`sync/mutations.ts`), reused here so a concurrent apply from two devices can't race a read-modify-write. */
export async function appendContactLabelId(
  db: Db,
  contactId: string,
  labelId: string,
): Promise<void> {
  await db
    .update(contacts)
    .set({ labelIds: sql`array_append(${contacts.labelIds}, ${labelId})`, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}

/** Permanently deletes a Contact (`deleteContact`, permanent — Recently Deleted is #224's own soft-delete pair, not this one). Returns whether a row actually existed to delete, the same shape `deleteNote` reads to decide whether a tombstone is owed. Accepts a `Tx` too — `merge-store.ts#mergeContacts` deletes the loser inside its own transaction. */
export async function deleteContactRow(
  db: Db | Tx,
  userId: string,
  contactId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .returning({ id: contacts.id });
  return deleted.length > 0;
}

export function toWireContact(row: ContactRow): Contact {
  return {
    id: row.id,
    addressBookId: row.addressBookId,
    name: row.name,
    emails: row.emails,
    phones: row.phones,
    addresses: row.addresses,
    websites: row.websites,
    organizations: row.organizations,
    birthday: row.birthday,
    notes: row.notes,
    labelIds: row.labelIds,
    customFields: row.customFields,
    banner: row.banner ?? null,
    photo: row.photo ?? null,
    categories: row.categories,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Soft-deletes a Contact and, on a linked card, every record it is linked
 * with in the same write (#224, `trashContact`, ADR-0026: "Delete on a
 * linked card deletes every linked record, one Undo restores all") —
 * `contactLinkMembersFor` resolves the group; an unlinked Contact is a group
 * of one, so this is the whole of `trashContact`'s own write either way.
 *
 * Each member's own upstream mirror identity is discarded in the same update
 * (ADR-0029: "removal discards the mirror ... a confirmed act") — captured
 * first, since the write-back outbox needs the *old* `googleResourceName`/
 * `microsoftId` after this clears the row's own copy. A Local member (no
 * mirror identity at all) simply queues nothing.
 */
export async function trashContactAndLinkedGroup(
  db: Db,
  userId: string,
  contactId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const memberIds = await contactLinkMembersFor(tx, userId, contactId);
    const rows = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(contacts.id, memberIds)));
    if (rows.length === 0) return;

    await tx
      .update(contacts)
      .set({
        deletedAt: new Date(),
        googleResourceName: null,
        googleEtag: null,
        googlePayload: null,
        microsoftId: null,
        microsoftChangeKey: null,
        microsoftPayload: null,
        carddavHref: null,
        carddavEtag: null,
        carddavRawVcard: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(contacts.userId, userId),
          inArray(
            contacts.id,
            rows.map((row) => row.id),
          ),
        ),
      );

    for (const row of rows) {
      if (row.connectedAccountId && row.googleResourceName) {
        await enqueueContactDeleteWriteBack(tx, {
          contactId: row.id,
          connectedAccountId: row.connectedAccountId,
          googleResourceName: row.googleResourceName,
        });
      } else if (row.microsoftId) {
        await enqueueMicrosoftContactWrite(tx, {
          addressBookId: row.addressBookId,
          microsoftId: row.microsoftId,
          kind: "delete",
        });
      } else if (row.carddavHref) {
        await enqueueContactCarddavDeleteWriteBack(tx, {
          contactId: row.id,
          addressBookId: row.addressBookId,
          carddavHref: row.carddavHref,
        });
      }
    }
  });
}

/**
 * Restores a Contact and, on a linked card, every record it was trashed with
 * (#224, `restoreContact`) — `trashContactAndLinkedGroup`'s own inverse:
 * trashing never prunes a `ContactLink`'s membership (only a *permanent*
 * delete does, `pruneContactLinkMembers`'s own doc comment), so the group
 * `contactLinkMembersFor` resolves here is exactly the one that was trashed
 * together, and restoring it whole is what makes "one Undo restores all"
 * true regardless of which single member the Client's own intent named.
 *
 * A member whose Address Book is Google-, Graph- or CardDAV-mirrored
 * re-queues a fresh upstream create — Google's and CardDAV's own
 * `enqueueContactRestoreWriteBack`/`enqueueContactCarddavRestoreWriteBack`,
 * or an upsert with no `microsoftId` left to match
 * (`enqueueMicrosoftContactWrite`'s own `"upsert"` kind, which already
 * creates when one is missing) — read off the Address Book's own capability
 * table, never the row's now-cleared mirror columns, since those are exactly
 * what `trashContactAndLinkedGroup` discarded.
 */
export async function restoreContactAndLinkedGroup(
  db: Db,
  userId: string,
  contactId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const memberIds = await contactLinkMembersFor(tx, userId, contactId);
    const rows = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(contacts.id, memberIds)));
    if (rows.length === 0) return;

    await tx
      .update(contacts)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(contacts.userId, userId),
          inArray(
            contacts.id,
            rows.map((row) => row.id),
          ),
        ),
      );

    for (const row of rows) {
      const capabilityTableId = await addressBookCapabilityTableId(tx, row.addressBookId);
      if (capabilityTableId === "google" && row.connectedAccountId) {
        await enqueueContactRestoreWriteBack(tx, {
          contactId: row.id,
          connectedAccountId: row.connectedAccountId,
        });
      } else if (capabilityTableId === "microsoft") {
        await enqueueMicrosoftContactWrite(tx, {
          addressBookId: row.addressBookId,
          contactId: row.id,
          kind: "upsert",
        });
      } else if (capabilityTableId === "caldav_carddav" && row.connectedAccountId) {
        await enqueueContactCarddavRestoreWriteBack(tx, {
          contactId: row.id,
          addressBookId: row.addressBookId,
        });
      }
    }
  });
}

/**
 * Creates or refreshes one Google-mirrored Contact, keyed by its upstream
 * `resourceName` within its Address Book (`db/schema.ts`'s own
 * `contacts_address_book_google_resource_key` unique index) — the sync
 * loop's only write for a Person that isn't a delete
 * (`google/people-sync.ts`'s own full-sync and incremental-sync ticks
 * alike). Returns the winning row's id, whether freshly inserted or already
 * present, since `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` reports
 * either the same way.
 */
export async function upsertGoogleContact(
  db: Db,
  args: {
    addressBookId: string;
    userId: string;
    connectedAccountId: string;
    resourceName: string;
    etag: string;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  // Projected once, here, so every caller (a full walk, an incremental
  // delta, or a write-back's own confirm) shows the same field families a
  // mirrored Contact's Details view reads (`mapping.ts#googlePersonToContactFields`'s
  // own doc comment on why this can't be left for a later ticket).
  const fields = googlePersonToContactFields(args.payload);
  const [row] = await db
    .insert(contacts)
    .values({
      id: generateUlid(),
      addressBookId: args.addressBookId,
      userId: args.userId,
      connectedAccountId: args.connectedAccountId,
      googleResourceName: args.resourceName,
      googleEtag: args.etag,
      googlePayload: args.payload,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [contacts.addressBookId, contacts.googleResourceName],
      // `contacts_address_book_google_resource_key` (`db/schema.ts`) is a
      // partial index (`where google_resource_name is not null`) — the
      // same predicate has to ride along here or Postgres can't infer it
      // as this conflict's arbiter (the same shape `ensureLocalAddressBook`/
      // `ensureGoogleAddressBook` already need for their own partial
      // indexes' `onConflictDoNothing`).
      targetWhere: sql`${contacts.googleResourceName} is not null`,
      set: { googleEtag: args.etag, googlePayload: args.payload, updatedAt: new Date(), ...fields },
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error("upsertGoogleContact: insert-or-update returned no row");
  return row.id;
}

/**
 * A mirrored Google Contact's own writable-fields slice, straight off its
 * already-applied (optimistic) row — `google/write-back-loop.ts`'s own
 * "read fresh, never trust a captured snapshot" read for the *outgoing*
 * side of a write-back (`db/schema.ts#contactGoogleWriteBacks`'s own doc
 * comment on why this table carries no field snapshot of its own).
 */
export function contactWritableFieldsFromRow(row: ContactRow): ContactWritableFields {
  return {
    name: row.name,
    emails: row.emails,
    phones: row.phones,
    addresses: row.addresses,
    websites: row.websites,
    organizations: row.organizations,
    birthday: row.birthday,
    notes: row.notes,
    customFields: row.customFields,
  };
}

/**
 * Adopts a `updateContact` write-back's own successful response as this
 * Contact's new mirror state (#216) — both the concurrency bookkeeping
 * (`googleEtag`/`googlePayload`, chained forward exactly like a full/
 * incremental sync tick's own `upsertGoogleContact`) and the typed field
 * columns, re-derived from the response rather than assumed to already
 * match what this Client wrote: Google's own server-side normalization
 * (a `formattedType`, a canonicalized phone number) means the response is
 * the more current truth of the two.
 */
export async function confirmGoogleContactWrite(
  db: Db,
  contactId: string,
  person: Record<string, unknown> & { etag: string },
): Promise<void> {
  await db
    .update(contacts)
    .set({
      ...googlePersonToContactFields(person),
      googleEtag: person.etag,
      googlePayload: person,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
}

/**
 * Adopts a "restore" write-back's own successful `createContact` response as
 * this Contact's brand-new mirror state (#224) — `confirmGoogleContactWrite`'s
 * own shape, plus stamping `googleResourceName` itself, which an update never
 * changes but a create always mints fresh. Same Wicket `contactId` as before
 * (`restoreContactAndLinkedGroup` never re-creates the row), which is the
 * whole of what keeps Labels and links following it back across the round
 * trip.
 */
export async function confirmGoogleContactCreate(
  db: Db,
  contactId: string,
  person: Record<string, unknown> & { resourceName: string; etag: string },
): Promise<void> {
  await db
    .update(contacts)
    .set({
      ...googlePersonToContactFields(person),
      googleResourceName: person.resourceName,
      googleEtag: person.etag,
      googlePayload: person,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
}

/**
 * "Upstream wins" (#216, spec's own §Sync): reverts a mirrored Contact's
 * writable fields back to whatever `googlePayload` — untouched by any
 * optimistic local edit, `db/schema.ts#contactGoogleWriteBacks`'s own doc
 * comment — already says Google's last-confirmed state was.
 * `googleEtag`/`googlePayload` themselves are left exactly as they stood:
 * this write never touched Google, so there is nothing about the
 * concurrency token to roll back.
 */
export async function revertGoogleContactFields(db: Db, row: ContactRow): Promise<void> {
  await db
    .update(contacts)
    .set({ ...googlePersonToContactFields(row.googlePayload ?? {}), updatedAt: new Date() })
    .where(eq(contacts.id, row.id));
}

/** A rejected "photo" write-back's own revert (#216) — `revertGoogleContactFields`'s sibling, back to the snapshot `contacts/write-back-outbox.ts#enqueueContactPhotoWriteBack` captured (there is no "last confirmed upstream photo" column to fall back to instead — that table's own doc comment). */
export async function revertContactPhoto(
  db: Db,
  contactId: string,
  previousPhoto: Contact["photo"],
): Promise<void> {
  await db
    .update(contacts)
    .set({ photo: previousPhoto, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}

/** Every upstream `resourceName` currently mirrored into one Address Book — a full sync's own "what's here that the walk didn't see" diff (`google/people-sync.ts`). */
export async function listGoogleResourceNamesForAddressBook(
  db: Db,
  addressBookId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ resourceName: contacts.googleResourceName })
    .from(contacts)
    .where(and(eq(contacts.addressBookId, addressBookId), isNotNull(contacts.googleResourceName)));
  return new Set(rows.map((row) => row.resourceName as string));
}

/**
 * Deletes the Contacts named by these upstream `resourceName`s and records
 * each one's own tombstone — never the Address Book's own (that one
 * survives; only the Person is gone), unlike a whole Facet turning off
 * (`connected-accounts/removal.ts`'s "the parent's tombstone is enough"
 * shape, which doesn't apply here since the Address Book itself isn't being
 * removed). A no-op for an empty list, matching `recordTombstones`'s own
 * guard.
 */
export async function deleteGoogleContactsByResourceName(
  db: Db,
  addressBookId: string,
  resourceNames: string[],
): Promise<void> {
  if (resourceNames.length === 0) return;
  const rows = await db
    .select({ id: contacts.id, connectedAccountId: contacts.connectedAccountId })
    .from(contacts)
    .where(
      and(
        eq(contacts.addressBookId, addressBookId),
        inArray(contacts.googleResourceName, resourceNames),
      ),
    );
  if (rows.length === 0) return;

  // Same reason `mirror-discard.ts` prunes before deleting (#222): a
  // `ContactLink` naming an upstream-deleted Contact has no foreign key to
  // cascade through.
  await pruneContactLinkMembers(
    db,
    null,
    rows.map((row) => row.id),
  );
  await db.delete(contacts).where(
    inArray(
      contacts.id,
      rows.map((row) => row.id),
    ),
  );
  await recordTombstones(db, {
    mailAccountId: null,
    connectedAccountId: rows[0]?.connectedAccountId ?? null,
    collection: "Contact",
    entityIds: rows.map((row) => row.id),
  });
}

/**
 * Creates or refreshes one Graph-mirrored Contact, keyed by its upstream
 * `id` within its Address Book (`db/schema.ts`'s own
 * `contacts_address_book_microsoft_id_key` unique index) — `upsertGoogleContact`'s
 * own shape, generalized to a folder-scoped Origin, but **unlike**
 * `upsertGoogleContact`, this one *does* project `fields` into the row's own
 * typed columns (`name`/`emails`/`phones`/...) rather than leaving them at
 * their empty defaults: this ticket's own acceptance line ("the edit form
 * ... offers no second organisation and no Custom Fields") only makes sense
 * against real projected data, and Graph's own write path
 * (`contacts-sync.ts#drainMicrosoftContactWrites`) reads these same columns
 * back out to build its push — there is no second, Google-style "later
 * ticket" this projection is deferred to. `customFields` is never set here
 * (always `[]`, `contacts.microsoftPayload`'s own doc comment): Graph's
 * capability table forbids them outright, so there is nothing to hold.
 * `changeKey`/`categories` are read fresh from every upsert (a delta
 * round's own `changeKey` change, or the write path's own POST/PATCH
 * response) since both can move without any other field changing.
 */
export async function upsertMicrosoftContact(
  db: Db,
  args: {
    addressBookId: string;
    userId: string;
    connectedAccountId: string;
    microsoftId: string;
    changeKey: string;
    categories: string[];
    fields: ContactWritableFields;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      id: generateUlid(),
      addressBookId: args.addressBookId,
      userId: args.userId,
      connectedAccountId: args.connectedAccountId,
      ...args.fields,
      customFields: [],
      categories: args.categories,
      microsoftId: args.microsoftId,
      microsoftChangeKey: args.changeKey,
      microsoftPayload: args.payload,
    })
    .onConflictDoUpdate({
      target: [contacts.addressBookId, contacts.microsoftId],
      // The partial index's own predicate, same reasoning as
      // `upsertGoogleContact`'s own `targetWhere`.
      targetWhere: sql`${contacts.microsoftId} is not null`,
      set: {
        ...args.fields,
        customFields: [],
        categories: args.categories,
        microsoftChangeKey: args.changeKey,
        microsoftPayload: args.payload,
        updatedAt: new Date(),
      },
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error("upsertMicrosoftContact: insert-or-update returned no row");
  return row.id;
}

/** Every upstream Graph contact id currently mirrored into one Address Book — `contacts-sync.ts`'s own full-sync "what's here that the walk didn't see" diff. */
export async function listMicrosoftIdsForAddressBook(
  db: Db,
  addressBookId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ microsoftId: contacts.microsoftId })
    .from(contacts)
    .where(and(eq(contacts.addressBookId, addressBookId), isNotNull(contacts.microsoftId)));
  return new Set(rows.map((row) => row.microsoftId as string));
}

/** `deleteGoogleContactsByResourceName`'s own shape for Graph ids (#227) — a delta round's own tombstone signal. */
export async function deleteMicrosoftContactsById(
  db: Db,
  addressBookId: string,
  microsoftIds: string[],
): Promise<void> {
  if (microsoftIds.length === 0) return;
  const rows = await db
    .select({ id: contacts.id, connectedAccountId: contacts.connectedAccountId })
    .from(contacts)
    .where(
      and(eq(contacts.addressBookId, addressBookId), inArray(contacts.microsoftId, microsoftIds)),
    );
  if (rows.length === 0) return;

  await db.delete(contacts).where(
    inArray(
      contacts.id,
      rows.map((row) => row.id),
    ),
  );
  await recordTombstones(db, {
    mailAccountId: null,
    connectedAccountId: rows[0]?.connectedAccountId ?? null,
    collection: "Contact",
    entityIds: rows.map((row) => row.id),
  });
}

/**
 * Adds to Graph's write-through outbox (`microsoftContactWrites`'s own doc
 * comment, `db/schema.ts`) — `sync/mutations.ts`'s only way in, the instant
 * `createContact`/`updateContact`/`deleteContact` lands against a
 * Graph-mirrored Address Book. `kind: "delete"` captures `microsoftId` at
 * enqueue time (the Contact row is about to be gone); `kind: "upsert"`
 * leaves it null (`drainMicrosoftContactWrites` re-reads the row itself).
 */
export async function enqueueMicrosoftContactWrite(
  db: Db | Tx,
  args:
    | { addressBookId: string; contactId: string; kind: "upsert" }
    | { addressBookId: string; microsoftId: string; kind: "delete" },
): Promise<void> {
  await db.insert(microsoftContactWrites).values({
    id: generateUlid(),
    addressBookId: args.addressBookId,
    contactId: args.kind === "upsert" ? args.contactId : null,
    kind: args.kind,
    microsoftId: args.kind === "delete" ? args.microsoftId : null,
  });
}

/** Every queued write for one Address Book, oldest first — the drain's own FIFO, the same ordering `drainProtocolWrites`' own `orderBy` gives its outbox. */
export function listMicrosoftContactWritesForAddressBook(
  db: Db,
  addressBookId: string,
): Promise<MicrosoftContactWriteRow[]> {
  return db
    .select()
    .from(microsoftContactWrites)
    .where(eq(microsoftContactWrites.addressBookId, addressBookId))
    .orderBy(asc(microsoftContactWrites.createdAt));
}

/** Clears every outbox row the drain actually applied (or found to have nothing left worth applying) — a no-op for an empty list. */
export async function deleteMicrosoftContactWrites(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(microsoftContactWrites).where(inArray(microsoftContactWrites.id, ids));
}

/** Stamps what Graph's own create/update response reported back onto the pushed Contact — the same fields a pulled delta round would have set, so the next drain/sync tick reads a consistent `microsoftChangeKey`. */
export async function recordMicrosoftContactPush(
  db: Db,
  contactId: string,
  args: { microsoftId: string; changeKey: string; payload: Record<string, unknown> },
): Promise<void> {
  await db
    .update(contacts)
    .set({
      microsoftId: args.microsoftId,
      microsoftChangeKey: args.changeKey,
      microsoftPayload: args.payload,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
}

/**
 * Creates or refreshes one CardDAV-mirrored Contact, keyed by its own vCard
 * resource `href` within its Address Book (`db/schema.ts`'s own
 * `contacts_address_book_carddav_href_key` unique index) — `upsertMicrosoftContact`'s
 * own "project fields into the row's typed columns" shape, since CardDAV's
 * capability table holds Custom Fields too (unlike Graph's `customFields:
 * false`), `args.fields.customFields` rides straight through rather than
 * being forced to `[]`. `rawVcard` is stored verbatim — the ticket's own
 * honesty rule (`contacts.carddavRawVcard`'s own doc comment) — never
 * re-derived from `fields`, since it's the server's own bytes this app is
 * keeping a promise to preserve.
 */
export async function upsertCarddavContact(
  db: Db,
  args: {
    addressBookId: string;
    userId: string;
    connectedAccountId: string;
    href: string;
    etag: string | undefined;
    rawVcard: string;
    fields: ContactWritableFields;
    categories: string[];
  },
): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      id: generateUlid(),
      addressBookId: args.addressBookId,
      userId: args.userId,
      connectedAccountId: args.connectedAccountId,
      ...args.fields,
      categories: args.categories,
      carddavHref: args.href,
      carddavEtag: args.etag ?? null,
      carddavRawVcard: args.rawVcard,
    })
    .onConflictDoUpdate({
      target: [contacts.addressBookId, contacts.carddavHref],
      // The partial index's own predicate has to ride along here too, the
      // same reasoning `upsertGoogleContact`'s own `targetWhere` documents.
      targetWhere: sql`${contacts.carddavHref} is not null`,
      set: {
        ...args.fields,
        categories: args.categories,
        carddavEtag: args.etag ?? null,
        carddavRawVcard: args.rawVcard,
        updatedAt: new Date(),
      },
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error("upsertCarddavContact: insert-or-update returned no row");
  return row.id;
}

/**
 * Every upstream vCard `href` currently mirrored into one Address Book, each
 * with its own last-known `carddavEtag` — `contacts/carddav/contacts-sync.ts`'s
 * own two diffs share this one read: a `sync-collection` full walk only
 * needs the key set (`listGoogleResourceNamesForAddressBook`'s own "what's
 * here that the walk didn't see" shape), the ctag-fallback path needs the
 * etags too, to work out *which* of a dirty collection's members actually
 * changed rather than re-fetching every one of them.
 */
export async function listCarddavHrefEtagsForAddressBook(
  db: Db,
  addressBookId: string,
): Promise<Map<string, string | null>> {
  const rows = await db
    .select({ href: contacts.carddavHref, etag: contacts.carddavEtag })
    .from(contacts)
    .where(and(eq(contacts.addressBookId, addressBookId), isNotNull(contacts.carddavHref)));
  return new Map(rows.map((row) => [row.href as string, row.etag]));
}

/** `deleteGoogleContactsByResourceName`'s own shape for CardDAV hrefs (#226) — a `sync-collection`/ctag round's own tombstone signal. */
export async function deleteCarddavContactsByHref(
  db: Db,
  addressBookId: string,
  hrefs: string[],
): Promise<void> {
  if (hrefs.length === 0) return;
  const rows = await db
    .select({ id: contacts.id, connectedAccountId: contacts.connectedAccountId })
    .from(contacts)
    .where(and(eq(contacts.addressBookId, addressBookId), inArray(contacts.carddavHref, hrefs)));
  if (rows.length === 0) return;

  await pruneContactLinkMembers(
    db,
    null,
    rows.map((row) => row.id),
  );
  await db.delete(contacts).where(
    inArray(
      contacts.id,
      rows.map((row) => row.id),
    ),
  );
  await recordTombstones(db, {
    mailAccountId: null,
    connectedAccountId: rows[0]?.connectedAccountId ?? null,
    collection: "Contact",
    entityIds: rows.map((row) => row.id),
  });
}

/**
 * Adopts a write-back's own successful `PUT` response as this Contact's new
 * mirror state (#226) — `confirmGoogleContactWrite`'s own shape, serving
 * both an update (the `href` is unchanged) and a create/restore (a fresh
 * `href`) alike, since unlike Google's `create`/`update` pair, a CardDAV
 * `PUT` reports the same shape either way: a new `etag` to chain forward and
 * the raw vCard body this app itself just wrote (re-parsed here rather than
 * threading `fields`/`categories` through separately, so this is the one
 * place that derives them from the bytes actually now sitting on the
 * server).
 */
export async function confirmCarddavContactWrite(
  db: Db,
  contactId: string,
  args: { href: string; etag: string | undefined; rawVcard: string },
): Promise<void> {
  const parsed = parseVcard(args.rawVcard);
  await db
    .update(contacts)
    .set({
      ...parsed.fields,
      categories: parsed.categories,
      carddavHref: args.href,
      carddavEtag: args.etag ?? null,
      carddavRawVcard: args.rawVcard,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
}

/**
 * "Upstream wins" (#226) — `revertGoogleContactFields`'s own shape: reverts
 * a mirrored Contact's writable fields back to whatever `carddavRawVcard`
 * (untouched by any optimistic local edit) already says the server's
 * last-confirmed state was. A no-op when this Contact never had one yet (a
 * rejected first-ever "restore" create) — there is nothing confirmed to
 * revert *to*, the same "nothing to revert" case `write-back-loop.ts`'s own
 * restore-rejected branch documents for Google.
 */
export async function revertCarddavContactFields(db: Db, row: ContactRow): Promise<void> {
  if (!row.carddavRawVcard) return;
  const parsed = parseVcard(row.carddavRawVcard);
  await db
    .update(contacts)
    .set({ ...parsed.fields, categories: parsed.categories, updatedAt: new Date() })
    .where(eq(contacts.id, row.id));
}
