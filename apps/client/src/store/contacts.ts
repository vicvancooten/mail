import type {
  Contact,
  ContactBanner,
  ContactCapabilityTable,
  ContactPhoto,
  ContactWritableFields,
} from "@mail/shared";
import {
  contactsAreMergeable,
  generateUlid,
  getContactCapabilityTable,
  mapContactFieldsToCapabilityTable,
  mergeContactFields,
  pickContactMergeSurvivor,
} from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { uploadContactPhoto } from "../api/contact-photos.js";
import { fetchContactPhotoAsFile } from "../contacts/contact-photo.js";
import { readAddressBook } from "./address-books.js";
import { dropContactLinkMemberLocally, linkContacts, newContactLinkId } from "./contact-links.js";
import { localCache } from "./local-cache.js";
import { labelIdForName } from "./session.js";
import { enqueueUserMutation } from "./user-mutation-queue.js";

/**
 * A Local Contact's Local Cache row (#210). Structural actions (create,
 * update, delete, label, unlabel) all ride the User-scoped Optimistic
 * Action queue (`user-mutation-queue.ts`) with real inverses (ADR-0019) —
 * `store/notes.ts`'s own shape, extended by `updateContact` for the field
 * families a Note has no analogue of (`@mail/shared#contactWritableFieldsSchema`'s
 * own doc comment on why that one intent is its own inverse).
 */

/** A fresh Contact id, mintable before any content exists — `newNoteId`'s own shape. */
export function newContactId(): string {
  return generateUlid();
}

export function useContact(id: string | null): Contact | undefined {
  return useLiveQuery(() => readContact(id), [id]);
}

export async function readContact(id: string | null): Promise<Contact | undefined> {
  if (id === null) return undefined;
  return localCache().contacts.get(id);
}

/**
 * `contactsContactRoute`'s own deep-link guard (`router/routes.tsx`) —
 * `notesNoteRoute`'s own `noteExists` shape: a wrong id, one this Client
 * hasn't synced yet, or one soft-deleted (#224) redirects to the grid rather
 * than mounting the dialog against nothing. `readContact` itself still hands
 * a soft-deleted row back (the dialog's own `deletedAt` effect needs that
 * undiminished read to notice a concurrent delete arriving while it's open).
 */
export async function contactExists(id: string): Promise<boolean> {
  const contact = await readContact(id);
  return contact !== undefined && contact.deletedAt === null;
}

/** Every Contact in one Address Book, most recently updated first, minus anything in Recently Deleted (#224) — the whole of what a minimal "demonstrate the collection" list needs; the real card directory is #211's. */
export function useContactsForAddressBook(addressBookId: string | null): Contact[] | undefined {
  return useLiveQuery(() => readContactsForAddressBook(addressBookId), [addressBookId]);
}

export async function readContactsForAddressBook(addressBookId: string | null): Promise<Contact[]> {
  if (addressBookId === null) return [];
  const rows = await localCache().contacts.where("addressBookId").equals(addressBookId).toArray();
  return rows
    .filter((row) => row.deletedAt === null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Every Contact across every Address Book — unsorted and unfiltered, two
 * callers' own shared read:
 *
 * - The card directory (#211: "one list across every Address Book in
 *   Account Scope") narrows it by Scope, the search text and the selected
 *   Address Book chips, and sorts it by the User's own `contactsSortOrder`
 *   preference (`ContactsGrid.tsx`).
 * - Compose's merged recipient candidate set (#220): unlike a Correspondent,
 *   a Contact is not scoped to a Mail Account (`addressBookSchema`'s own doc
 *   comment — the Local Address Book rides the User's own Sync Scope, a
 *   mirrored one its Connected Account's), so composing from any Mail
 *   Account draws on the same whole set.
 *
 * A plain `toArray()` over every book, the same "small collection" posture
 * `address-books.ts#readLocalAddressBook` already takes. Filters out
 * Recently Deleted (#224) — `store/notes.ts#readNotes`'s own reasoning: a
 * soft-deleted Contact reads as gone to the card directory, compose ranking
 * and every other reader of this same array, `readDeletedContacts` below is
 * the one that wants it.
 */
export function useContacts(): Contact[] | undefined {
  return useLiveQuery(() => readContacts(), []);
}

export async function readContacts(): Promise<Contact[]> {
  const rows = await localCache().contacts.toArray();
  return rows.filter((row) => row.deletedAt === null);
}

/**
 * Recently Deleted (#224): every Contact this User has soft-deleted, most
 * recently deleted first — `readContacts`' own mirror image, filtering the
 * opposite way over the same `contacts` table rather than a second synced
 * collection, `store/notes.ts#readDeletedNotes`'s own shape. A purged row
 * (`contacts/contact-purge.ts`, 30 days on) simply stops appearing here the
 * next sync round, the same "tombstone removes the row" path any other
 * destroyed entity takes.
 */
export function useDeletedContacts(): Contact[] | undefined {
  return useLiveQuery(() => readDeletedContacts(), []);
}

export async function readDeletedContacts(): Promise<Contact[]> {
  const rows = await localCache().contacts.toArray();
  return rows
    .filter((row): row is Contact & { deletedAt: string } => row.deletedAt !== null)
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

/**
 * Creates a Contact (#210): writes the durable row optimistically and
 * enqueues the `createContact` intent whose real inverse is `deleteContact`
 * (ADR-0019) — `store/notes.ts#createNote`'s own shape, except the fields
 * are captured at creation time rather than filled in afterwards through a
 * second channel: a Contact has no freeform body to autosave, so there is
 * nothing gained by minting an empty row ahead of the User's first Save the
 * way a Note's blank document is (this ticket's own "whatever minimal
 * surface" framing — the Contacts App's own draft-as-you-type UX, if any,
 * is #211/#212's to add). `id` is minted by the caller (`newContactId`)
 * before this is ever called, the same offline-derivable-address reasoning
 * `newNoteId` already gives a Note.
 */
export async function createContact(
  id: string,
  addressBookId: string,
  fields: ContactWritableFields,
): Promise<void> {
  const now = new Date().toISOString();
  await localCache().contacts.put({
    id,
    addressBookId,
    labelIds: [],
    banner: null,
    photo: null,
    categories: [],
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
  });
  await enqueueUserMutation({ type: "createContact", contactId: id, addressBookId, fields });
}

/**
 * Deletes a Contact (#210): permanent, the real inverse of `createContact`
 * (ADR-0019) — never the User's own "Delete" control, which fires
 * `trashContact` below. Optimistic the same way `deleteNote` is: the local
 * row is gone the instant this is called, not once the Sync Backend answers.
 */
export async function deleteContact(id: string): Promise<void> {
  await localCache().contacts.delete(id);
  await enqueueUserMutation({ type: "deleteContact", contactId: id });
}

/**
 * Soft-deletes a Contact (#224): an Optimistic Action whose real inverse is
 * `restoreContact` (ADR-0019) — `store/notes.ts#trashNote`'s own shape, only
 * `deletedAt` flips, the row itself (its Labels, its links) stays exactly as
 * it was. The Sync Backend cascades this to every record `id` is linked with
 * (ADR-0026: "Delete on a linked card deletes every linked record") —
 * nothing to mirror locally for the other members here, they arrive on the
 * next sync round the same eventual-consistency window any other
 * server-only cascade already has. Callers raise the Undo toast themselves
 * right after this resolves (`contacts/ContactDialog.tsx`), the same split
 * `notes/NoteDialog.tsx`'s own Delete already draws.
 */
export async function trashContact(id: string): Promise<void> {
  await enqueueUserMutation({ type: "trashContact", contactId: id });
  await setDeletedLocally(id, new Date().toISOString());
}

/** Restores a Contact out of Recently Deleted, the real inverse of `trashContact`. */
export async function restoreContact(id: string): Promise<void> {
  await enqueueUserMutation({ type: "restoreContact", contactId: id });
  await setDeletedLocally(id, null);
}

async function setDeletedLocally(id: string, deletedAt: string | null): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.contacts, async () => {
    const row = await db.contacts.get(id);
    if (!row || row.deletedAt === deletedAt) return;
    await db.contacts.put({ ...row, deletedAt });
  });
}

/**
 * Edits a Contact's fields (#210): whole-replaces every writable family in
 * one `updateContact` intent (`@mail/shared#contactWritableFieldsSchema`'s
 * own doc comment) — never a per-family patch. Its real inverse (ADR-0019)
 * is calling this again with the fields as they stood before the edit; the
 * caller (the edit form) is the one holding that "before" state, the same
 * "component wires the toast, the store stays store" split
 * `trashNote`/`restoreNote`'s own callers already draw.
 */
export async function updateContact(id: string, fields: ContactWritableFields): Promise<void> {
  await enqueueUserMutation({ type: "updateContact", contactId: id, fields });
  await mergeContactFieldsLocally(id, fields);
}

async function mergeContactFieldsLocally(id: string, fields: ContactWritableFields): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.contacts, async () => {
    const row = await db.contacts.get(id);
    if (!row) return;
    await db.contacts.put({ ...row, ...fields, updatedAt: new Date().toISOString() });
  });
}

/**
 * Merges two Contacts in the same Address Book into one (#223, ADR-0026):
 * the older record survives and takes the other's fields
 * (`@mail/shared#mergeContactFields`), the other is permanently deleted —
 * `deleteContact`'s own destructive shape, not `createContact`/
 * `deleteContact`'s genuine inverse pair, so there is no undo to wire here
 * (this ticket's own acceptance line, "undoable on the same terms as a
 * delete" — today's `deleteContact` has none either; Recently Deleted is
 * #224's own to add, to both at once).
 *
 * `null` when the pair isn't actually mergeable (a stale local row, or a
 * cross-Origin pair the caller should have offered Link for instead,
 * `@mail/shared#contactsAreMergeable`) — the caller (`ContactDialog.tsx`)
 * only ever calls this from a same-Address-Book duplicate suggestion, so
 * this is a defensive guard against a race, never the ordinary path.
 * Which record survived/was deleted comes back so the caller can decide
 * whether the Person Page it has open just lost its own record
 * (`handleDeleteRecord`'s own "closes only when the record deleted is the
 * one the route is open on" shape).
 */
export async function mergeContacts(
  contactId: string,
  otherContactId: string,
): Promise<{ survivorId: string; loserId: string } | null> {
  const db = localCache();
  const [a, b] = await Promise.all([db.contacts.get(contactId), db.contacts.get(otherContactId)]);
  if (!a || !b || !contactsAreMergeable(a, b)) return null;

  const { survivor, loser } = pickContactMergeSurvivor(a, b);
  const addressBook = await readAddressBook(survivor.addressBookId);
  if (!addressBook) return null;
  const table = getContactCapabilityTable(addressBook.capabilityTableId);
  const fields = mergeContactFields(survivor, loser, table);

  await enqueueUserMutation({
    type: "mergeContacts",
    contactId: survivor.id,
    otherContactId: loser.id,
  });
  await db.transaction("rw", db.contacts, async () => {
    const row = await db.contacts.get(survivor.id);
    if (row) await db.contacts.put({ ...row, ...fields, updatedAt: new Date().toISOString() });
    await db.contacts.delete(loser.id);
  });
  await dropContactLinkMemberLocally(loser.id);

  return { survivorId: survivor.id, loserId: loser.id };
}

/** `source`'s own writable fields, `ContactWritableFields`'s exact shape — `Contact` carries every one of them plus its own identity/side-channels, so this is just the projection Copy/Move need to hand `createContact`/`mapContactFieldsToCapabilityTable`. */
function writableFieldsOf(source: Contact): ContactWritableFields {
  return {
    name: source.name,
    emails: source.emails,
    phones: source.phones,
    addresses: source.addresses,
    websites: source.websites,
    organizations: source.organizations,
    birthday: source.birthday,
    notes: source.notes,
    customFields: source.customFields,
  };
}

/** Re-uploads `source`'s own photo, if it has one, onto `targetId` — best-effort (Copy/Move both still succeed without a photo the upload happens to reject or fail to fetch), since a photo is never part of a capability table (`contacts.ts#contactPhotoSchema`'s own doc comment) and so is never among Copy's own named drops. */
async function copyPhoto(source: Contact, targetId: string): Promise<void> {
  if (!source.photo) return;
  try {
    const file = await fetchContactPhotoAsFile(source);
    if (!file) return;
    const photo = await uploadContactPhoto(targetId, file);
    await recordContactPhoto(targetId, photo);
  } catch {
    // Best-effort — the Copy/Move itself already succeeded without it.
  }
}

/**
 * The actual "new Contact in the target" work Copy and Move both do: fields
 * mapped to the target's own capability table
 * (`mapContactFieldsToCapabilityTable`) before ever reaching `createContact`
 * — whatever survives the trim is a genuine, ordinary create there,
 * capability-checked fresh against that Origin exactly as a User's own Save
 * would be (`sync.ts#userMutationIntentSchema`'s own doc comment on why
 * `createContact` now names its own target). Never linked here — that is
 * `copyContact`'s own addition, since `moveContact`'s source doesn't remain
 * to be linked to.
 */
async function createContactCopy(
  source: Contact,
  targetAddressBookId: string,
  targetTable: ContactCapabilityTable,
): Promise<string> {
  const { fields } = mapContactFieldsToCapabilityTable(writableFieldsOf(source), targetTable);
  const id = newContactId();
  await createContact(id, targetAddressBookId, fields);
  await copyPhoto(source, id);
  return id;
}

/**
 * Copies a Contact into another Address Book (#225, ADR-0026): `createContactCopy`
 * above, plus the link a Copy leaves that a Move never does — "the copy is
 * linked to the original where the original remains".
 */
export async function copyContact(
  source: Contact,
  targetAddressBookId: string,
  targetTable: ContactCapabilityTable,
): Promise<string> {
  const id = await createContactCopy(source, targetAddressBookId, targetTable);
  await linkContacts(newContactLinkId(), id, source.id);
  return id;
}

/** The undo a caller wires through `announceUndoableAction` (`ContactDialog.tsx`) once `moveContact` returns — reversing both halves of the move in one call, `createContact`/`deleteContact`'s own real-inverse pairing extended to a compound action. */
export interface ContactMoveResult {
  newContactId: string;
  undo: () => void;
}

/**
 * Moves a Contact into another Address Book (#225, ADR-0026: "Move is Copy
 * plus Delete of the original — one action, one Undo"): `copyContact`
 * above, without the link a Copy leaves (nothing remains to link to), then
 * a permanent `deleteContact` of the source — today's only delete, #224's
 * Recently Deleted own to add later. The returned `undo` reverses both
 * halves: it deletes the copy and recreates the original **with its
 * original id**, `createContact`'s own tolerance for a Client-minted id
 * already known ahead of time — the same "genuine inverse" ADR-0019 already
 * gives a plain `createContact`/`deleteContact` pair, just replaying two of
 * them together. `banner`/`photo` are restored too (side channels
 * `ContactWritableFields` never carries, `contacts.ts#contactSchema`'s own
 * doc comment) — best-effort for the photo the same way `copyContact`'s own
 * upload is, since the blob itself may already be collected by the time a
 * User reaches for Undo.
 */
export async function moveContact(
  source: Contact,
  targetAddressBookId: string,
  targetTable: ContactCapabilityTable,
): Promise<ContactMoveResult> {
  const newId = await createContactCopy(source, targetAddressBookId, targetTable);
  const originalId = source.id;
  const originalAddressBookId = source.addressBookId;
  const originalFields = writableFieldsOf(source);
  const originalBanner = source.banner;
  const originalPhoto = source.photo;

  await deleteContact(originalId);

  // Typed `() => void` on `ContactMoveResult` (`announceUndoableAction`'s
  // own fire-and-forget shape never awaits its `undos` callbacks) but built
  // as an `async` function regardless — TypeScript's own "a Promise-returning
  // function satisfies a void-returning call signature" rule means a caller
  // that *does* want to wait for it (a test) still can with a plain `await`.
  const undo = async () => {
    await createContact(originalId, originalAddressBookId, originalFields);
    if (originalBanner) await setContactBanner(originalId, originalBanner);
    if (originalPhoto) await recordContactPhoto(originalId, originalPhoto);
    await deleteContact(newId);
  };

  return { newContactId: newId, undo };
}

/** Applies a Label to a Contact (#210) — `labelNote`'s shape: the row's own `labelIds` is what every reader sees, no separate overlay table. */
export async function labelContact(id: string, name: string): Promise<void> {
  await enqueueUserMutation({ type: "labelContact", contactId: id, name });
  await addLabelLocally(id, name);
}

/** Removes a Label from a Contact (#210) — `unlabelNote`'s shape; see `labelContact` above. */
export async function unlabelContact(id: string, name: string): Promise<void> {
  await enqueueUserMutation({ type: "unlabelContact", contactId: id, name });
  await removeLabelLocally(id, name);
}

async function addLabelLocally(id: string, name: string): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.contacts, async () => {
    const row = await db.contacts.get(id);
    const labelId = labelIdForName(name);
    if (!row || labelId === null || row.labelIds.includes(labelId)) return;
    await db.contacts.put({ ...row, labelIds: [...row.labelIds, labelId] });
  });
}

async function removeLabelLocally(id: string, name: string): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.contacts, async () => {
    const row = await db.contacts.get(id);
    const labelId = labelIdForName(name);
    if (!row || labelId === null) return;
    await db.contacts.put({ ...row, labelIds: row.labelIds.filter((entry) => entry !== labelId) });
  });
}

/** Sets or clears a Contact's banner (#212) — `labelContact`'s own shape: a Wicket-only decoration on any Contact regardless of Origin, never gated by the Origin's capability table (`@mail/shared#contactBannerSchema`'s own doc comment). */
export async function setContactBanner(id: string, banner: ContactBanner | null): Promise<void> {
  await enqueueUserMutation({ type: "setContactBanner", contactId: id, banner });
  const db = localCache();
  await db.transaction("rw", db.contacts, async () => {
    const row = await db.contacts.get(id);
    if (!row) return;
    await db.contacts.put({ ...row, banner, updatedAt: new Date().toISOString() });
  });
}

/**
 * Mirrors a photo upload/remove into the Local Cache once the Blob Store
 * round trip actually succeeds (#213) — `recordAttachmentUploaded`'s own
 * shape (`store/compositions.ts`), not an Optimistic Action: the bytes have
 * to exist server-side before there is anything real to show, so unlike
 * `setContactBanner` there is no local write ahead of the network call, only
 * after it. The caller (`ContactDialog.tsx`'s own photo picker) is what
 * calls `uploadContactPhoto`/`removeContactPhoto` (`api/contact-photos.ts`)
 * first and this only once that resolves.
 */
export async function recordContactPhoto(id: string, photo: ContactPhoto | null): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.contacts, async () => {
    const row = await db.contacts.get(id);
    if (!row) return;
    await db.contacts.put({ ...row, photo, updatedAt: new Date().toISOString() });
  });
}
