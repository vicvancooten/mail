import { CONTACT_PHOTO_MAX_BYTES, isContactPhotoMimeType } from "@mail/shared";
import type { AddressBookRow } from "../../address-books/store.js";
import {
  clearMicrosoftDeltaLink,
  ensureMicrosoftAddressBook,
  recordMicrosoftDeltaLink,
} from "../../address-books/store.js";
import type { Db } from "../../db/client.js";
import { putContactPhoto } from "../photo-store.js";
import {
  contactRowById,
  deleteMicrosoftContactsById,
  deleteMicrosoftContactWrites,
  listMicrosoftContactWritesForAddressBook,
  listMicrosoftIdsForAddressBook,
  recordMicrosoftContactPush,
  upsertMicrosoftContact,
} from "../store.js";
import {
  type GraphContact,
  GraphDeltaResyncRequiredError,
  type MicrosoftContactsClient,
} from "./client.js";
import {
  contactWritableFieldsToGraphBody,
  graphContactCategories,
  graphContactToWritableFields,
} from "./mapping.js";

/**
 * Mirrors one Connected Account's Graph contacts whole (#227): discovers
 * every contact folder, mints or refreshes each one's own mirrored Address
 * Book, walks its `/contacts/delta` (a fresh round when no `deltaLink` is
 * stored — Graph's own model draws no full/incremental distinction the way
 * Google's `requestSyncToken` does), then drains that folder's own
 * write-through outbox. The one caller today is `poll-loop.ts`'s own tick,
 * once per Connected Account with an active Contacts Facet — the same
 * shape `contacts/google/people-sync.ts#syncGoogleContactsForAccount`
 * already established for its own sibling loop.
 */
export interface SyncMicrosoftContactsArgs {
  userId: string;
  connectedAccountId: string;
  accessToken: string;
}

/** The default root Contacts folder's own display name — Graph never hands this back directly (`discoverMicrosoftContactFolders`'s own doc comment), so this is what a Client actually sees until Graph's folder resource itself is fetched by id. */
export const MICROSOFT_DEFAULT_CONTACT_FOLDER_NAME = "Contacts";

export async function syncMicrosoftContactsForAccount(
  db: Db,
  client: MicrosoftContactsClient,
  args: SyncMicrosoftContactsArgs,
): Promise<void> {
  const folders = await discoverMicrosoftContactFolders(client, args.accessToken);
  for (const folder of folders) {
    const addressBook = await ensureMicrosoftAddressBook(db, {
      userId: args.userId,
      connectedAccountId: args.connectedAccountId,
      folderId: folder.id,
      name: folder.name,
    });
    // #215's own acceptance line: "the row stays so it can be re-mirrored" —
    // an unmirrored Address Book already had its Contacts discarded at the
    // moment of unmirroring (`address-books/store.ts#unmirrorAddressBook`);
    // skip both the delta round and the write-back drain for this folder so
    // nothing recreates or re-pushes them before the User re-mirrors it.
    if (!addressBook.mirrored) continue;
    await runDeltaSync(db, client, addressBook, args);
    await drainMicrosoftContactWrites(db, client, addressBook, args.accessToken);
  }
}

/**
 * `GET /me/contactFolders` only ever returns the User's own *named* child
 * folders — its own description is "the contact folder collection **in**
 * the default Contacts folder", the same phrasing Outlook's mail folders
 * API uses for "child folders of", not "including". The default root
 * folder itself carries no `displayName` to list under and has no
 * documented well-known name (unlike `mailFolders/inbox`), so it is found
 * instead off whichever source actually names its id: every named folder's
 * own `parentFolderId` (all of them point at the same default root, being
 * its direct children), or — when there are no named folders yet — the
 * `parentFolderId` of any one existing Contact
 * (`client.defaultContactFolderId`). A mailbox with neither a named folder
 * nor a single Contact yet has no discoverable default-folder id at all;
 * this walk simply finds nothing to mirror that tick and tries again next
 * time, since Outlook always ends up minting at least one of the two the
 * moment a Contact is ever added.
 */
async function discoverMicrosoftContactFolders(
  client: MicrosoftContactsClient,
  accessToken: string,
): Promise<{ id: string; name: string }[]> {
  const named = await client.listContactFolders(accessToken);
  const folders = named.map((folder) => ({ id: folder.id, name: folder.displayName }));

  const defaultId = named[0]?.parentFolderId ?? (await client.defaultContactFolderId(accessToken));
  if (defaultId && !folders.some((folder) => folder.id === defaultId)) {
    folders.unshift({ id: defaultId, name: MICROSOFT_DEFAULT_CONTACT_FOLDER_NAME });
  }
  return folders;
}

async function runDeltaSync(
  db: Db,
  client: MicrosoftContactsClient,
  addressBook: AddressBookRow,
  args: SyncMicrosoftContactsArgs,
): Promise<void> {
  try {
    await runDeltaRound(db, client, addressBook, args, addressBook.microsoftDeltaLink);
  } catch (err) {
    if (!(err instanceof GraphDeltaResyncRequiredError)) throw err;
    // learn.microsoft.com/graph/delta-query-overview#limitations: "the
    // application must restart with a full synchronization" — never
    // retried against the stale link, the same posture
    // `people-sync.ts#syncGoogleContactsForAccount` already takes for
    // `EXPIRED_SYNC_TOKEN`.
    await clearMicrosoftDeltaLink(db, addressBook.id);
    await runDeltaRound(db, client, addressBook, args, null);
  }
}

/**
 * One delta round, every page: `deltaLink === null` walks the whole folder
 * fresh (Graph's own "no distinction between full and incremental" model,
 * `syncMicrosoftContactsForAccount`'s own doc comment) — a fresh round is
 * also the definitive membership list, so a Contact it doesn't see this
 * time is tombstoned (`people-sync.ts#runFullSync`'s own "additive-safe"
 * reasoning); an incremental round (a stored `deltaLink`) only ever applies
 * what the round itself reports, upsert or `@removed` alike.
 */
async function runDeltaRound(
  db: Db,
  client: MicrosoftContactsClient,
  addressBook: AddressBookRow,
  args: SyncMicrosoftContactsArgs,
  deltaLink: string | null,
): Promise<void> {
  const folderId = addressBook.microsoftFolderId;
  if (!folderId) {
    throw new Error(`Address Book ${addressBook.id} has no microsoftFolderId to sync against`);
  }
  const isFreshWalk = deltaLink === null;

  const seen = new Set<string>();
  const removedIds: string[] = [];
  let link: string | undefined = deltaLink ?? undefined;
  let finalDeltaLink: string | undefined;

  do {
    const page = await client.deltaContacts(args.accessToken, folderId, link);
    for (const contact of page.contacts) {
      if (isRemovedMarker(contact)) {
        removedIds.push(contact.id);
        continue;
      }
      const contactId = await upsertMicrosoftContact(db, {
        addressBookId: addressBook.id,
        userId: args.userId,
        connectedAccountId: args.connectedAccountId,
        microsoftId: contact.id,
        changeKey: contact.changeKey,
        categories: graphContactCategories(contact),
        fields: graphContactToWritableFields(contact),
        payload: contact,
      });
      await syncContactPhoto(db, client, args, contactId, contact.id);
      seen.add(contact.id);
    }
    link = page.nextLink;
    if (page.deltaLink) finalDeltaLink = page.deltaLink;
  } while (link);

  await deleteMicrosoftContactsById(db, addressBook.id, removedIds);

  if (isFreshWalk) {
    const mirrored = await listMicrosoftIdsForAddressBook(db, addressBook.id);
    const stale = [...mirrored].filter((id) => !seen.has(id));
    await deleteMicrosoftContactsById(db, addressBook.id, stale);
  }

  // `finalDeltaLink` is only absent if Graph's response shape ever changes
  // out from under this — if so, the next tick's "no stored link" check
  // runs another fresh walk rather than silently going stale, the same
  // fallback `people-sync.ts#runFullSync` leans on for `nextSyncToken`.
  if (finalDeltaLink) await recordMicrosoftDeltaLink(db, addressBook.id, finalDeltaLink);
}

function isRemovedMarker(contact: GraphContact): boolean {
  return "@removed" in contact;
}

/**
 * Fetches the contact's photo, if any, through Graph's own binary endpoint
 * and stores it in the same Blob Store a Local Contact's own upload uses
 * (#213's `photo-store.ts#putContactPhoto`, landed alongside this ticket) —
 * this ticket's own acceptance line: "Photo round-trips through Graph's
 * binary endpoint within its 4 MB cap". Only the download half is ever
 * exercised: there is no photo-editing UI yet, so nothing here ever pushes
 * a photo back upstream. An unrecognised content type (`CONTACT_PHOTO_MIME_TYPES`'s
 * own fixed set) or a failed fetch is skipped rather than failing the whole
 * Contact upsert — the rest of the round keeps going, the same per-item
 * isolation `poll-loop.ts`'s own per-account `try`/`catch` already gives a
 * whole account.
 */
async function syncContactPhoto(
  db: Db,
  client: MicrosoftContactsClient,
  args: SyncMicrosoftContactsArgs,
  contactId: string,
  microsoftId: string,
): Promise<void> {
  try {
    const photo = await client.getContactPhoto(args.accessToken, microsoftId);
    if (!photo || !isContactPhotoMimeType(photo.contentType)) return;
    await putContactPhoto(db, {
      userId: args.userId,
      contactId,
      bytes: Buffer.from(photo.base64, "base64"),
      mimeType: photo.contentType,
      maxBytes: CONTACT_PHOTO_MAX_BYTES,
    });
  } catch {
    // A transient fetch failure, or a photo Graph reports but this pass
    // can't store (over `CONTACT_PHOTO_MAX_BYTES`, though Graph's own 4 MB
    // ceiling never exceeds it) — the Contact itself is already mirrored
    // either way; the next sync tick tries the photo again.
  }
}

/**
 * Applies every queued Graph write for one Address Book (#227,
 * `db/schema.ts#microsoftContactWrites`'s own doc comment): `upsert` reads
 * the Contact's *current* local fields fresh and either creates it upstream
 * (no `microsoftId` yet) or `PATCH`es it — comparing a fresh `getContact`
 * read's `changeKey` against the one stored locally first (this ticket's
 * own acceptance line, `client.ts`'s own doc comment on the race this
 * cannot fully close); a mismatch means someone else changed this Contact
 * upstream since our own local edit started, and this drop the local edit's
 * own push rather than risk overwriting a change it never saw — the row
 * stays queued as far as Wicket's own local state is concerned (the User's
 * edit already landed locally; only the upstream push is skipped), which is
 * exactly the lost-update caveat this ticket documents rather than solves.
 * `delete` removes the upstream Contact by its captured id. Every outbox
 * row this pass touches — pushed, or found to have nothing left worth
 * pushing — is cleared; there is no explicit rollback path, the same
 * `protocolWrites`' own doc comment.
 */
export async function drainMicrosoftContactWrites(
  db: Db,
  client: MicrosoftContactsClient,
  addressBook: AddressBookRow,
  accessToken: string,
): Promise<void> {
  const rows = await listMicrosoftContactWritesForAddressBook(db, addressBook.id);
  if (rows.length === 0) return;
  const folderId = addressBook.microsoftFolderId;
  if (!folderId) return;

  const done: string[] = [];
  for (const row of rows) {
    if (row.kind === "delete") {
      if (row.microsoftId) {
        await client.deleteContact(accessToken, row.microsoftId);
      }
      done.push(row.id);
      continue;
    }

    const contact = row.contactId ? await contactRowById(db, row.contactId) : null;
    if (!contact) {
      // Deleted locally since this was queued — nothing left to push.
      done.push(row.id);
      continue;
    }

    const fields = {
      name: contact.name,
      emails: contact.emails,
      phones: contact.phones,
      addresses: contact.addresses,
      websites: contact.websites,
      organizations: contact.organizations,
      birthday: contact.birthday,
      notes: contact.notes,
      customFields: contact.customFields,
    };
    const body = contactWritableFieldsToGraphBody(fields);

    if (!contact.microsoftId) {
      const created = await client.createContact(accessToken, folderId, body);
      await recordMicrosoftContactPush(db, contact.id, {
        microsoftId: created.id,
        changeKey: created.changeKey,
        payload: created,
      });
      done.push(row.id);
      continue;
    }

    const current = await client.getContact(accessToken, contact.microsoftId);
    if (!current) {
      // Deleted upstream since our own copy was last synced — nothing left
      // to compare a changeKey against; drop the push.
      done.push(row.id);
      continue;
    }
    if (current.changeKey !== contact.microsoftChangeKey) {
      // The weak-concurrency compare this ticket documents: someone else
      // changed this Contact upstream since we last saw it. Skip the push
      // rather than overwrite a change this pass never read.
      done.push(row.id);
      continue;
    }

    const updated = await client.updateContact(accessToken, contact.microsoftId, body);
    await recordMicrosoftContactPush(db, contact.id, {
      microsoftId: updated.id,
      changeKey: updated.changeKey,
      payload: updated,
    });
    done.push(row.id);
  }

  await deleteMicrosoftContactWrites(db, done);
}
