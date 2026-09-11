import { CONTACT_PHOTO_MAX_BYTES, isContactPhotoMimeType } from "@mail/shared";
import type { AddressBookRow } from "../../address-books/store.js";
import {
  clearCarddavSyncToken,
  ensureCarddavAddressBook,
  recordCarddavSync,
} from "../../address-books/store.js";
import type { Db } from "../../db/client.js";
import { putContactPhoto } from "../photo-store.js";
import {
  deleteCarddavContactsByHref,
  listCarddavHrefEtagsForAddressBook,
  upsertCarddavContact,
} from "../store.js";
import {
  type CarddavClient,
  type CarddavCredentials,
  CarddavSyncTokenInvalidError,
  type CarddavVCard,
} from "./client.js";
import { parseVcard } from "./vcard.js";

/**
 * Mirrors one Connected Account's CardDAV contacts whole (#226): discovers
 * every address book collection under the Contacts Facet's own
 * `davHomeSetUrl` (#203), mints or refreshes each one's own mirrored
 * Address Book, then drives its own `sync-collection`/ctag round —
 * `contacts/microsoft/contacts-sync.ts#syncMicrosoftContactsForAccount`'s
 * own shape, generalized to a server this app discovers generically rather
 * than one fixed API's own folder list. The one caller today is
 * `poll-loop.ts`'s own tick, once per Connected Account with an active
 * Contacts Facet.
 */
export interface SyncCarddavContactsArgs {
  userId: string;
  connectedAccountId: string;
  homeSetUrl: string;
  credentials: CarddavCredentials;
}

/** A CardDAV server's collection has no reliable "this is the default Contacts book" signal the way Graph's root folder does — used only when a collection reports no `displayname` of its own. */
const CARDDAV_DEFAULT_ADDRESS_BOOK_NAME = "Contacts";

export async function syncCarddavContactsForAccount(
  db: Db,
  client: CarddavClient,
  args: SyncCarddavContactsArgs,
): Promise<void> {
  const discovered = await client.fetchAddressBooks({
    homeSetUrl: args.homeSetUrl,
    credentials: args.credentials,
  });
  for (const book of discovered) {
    const addressBook = await ensureCarddavAddressBook(db, {
      userId: args.userId,
      connectedAccountId: args.connectedAccountId,
      collectionUrl: book.url,
      name: book.displayName.trim() || CARDDAV_DEFAULT_ADDRESS_BOOK_NAME,
    });

    // #215's own acceptance line: "the row stays so it can be re-mirrored" —
    // an unmirrored Address Book already had its Contacts discarded at the
    // moment of unmirroring (`address-books/store.ts#unmirrorAddressBook`);
    // skip this collection's own round entirely so nothing recreates them
    // before the User re-mirrors it.
    if (!addressBook.mirrored) continue;

    if (book.supportsSyncCollection) {
      await runWebdavSync(db, client, addressBook, args);
    } else {
      await runCtagSync(db, client, addressBook, book.ctag, args);
    }
  }
}

/**
 * RFC 6578's own REPORT, with the ticket's own "a stale sync-token triggers
 * a full re-walk" fallback: any failure against a *stored* token
 * (`CarddavSyncTokenInvalidError`, `client.ts`'s own doc comment on why this
 * is never narrowed to one status code) clears it and retries once with none
 * — which, per RFC 6578 §3.2's own empty-token semantics, is a full listing,
 * not a special case this function has to branch on separately.
 */
async function runWebdavSync(
  db: Db,
  client: CarddavClient,
  addressBook: AddressBookRow,
  args: SyncCarddavContactsArgs,
): Promise<void> {
  const collectionUrl = requireCollectionUrl(addressBook);
  const syncToken = addressBook.carddavSyncToken ?? undefined;
  try {
    await runSyncCollectionRound(db, client, addressBook, collectionUrl, syncToken, args);
  } catch (err) {
    if (!(err instanceof CarddavSyncTokenInvalidError)) throw err;
    await clearCarddavSyncToken(db, addressBook.id);
    await runSyncCollectionRound(db, client, addressBook, collectionUrl, undefined, args);
  }
}

/**
 * One `sync-collection` round. `syncToken === undefined` is a full listing —
 * RFC 6578 §3.2's own "empty sync-token means give me everything" — and is
 * therefore also the definitive membership list for this collection: any
 * Contact this app still mirrors that the round didn't report is stale,
 * tombstoned the same "additive-safe" way `people-sync.ts#runFullSync`
 * already tombstones a Google full walk's own leftovers. An *incremental*
 * round (a set `syncToken`) only ever applies what it itself reports,
 * upsert or delete alike — RFC 6578's whole point is that it already names
 * every change since the last one.
 */
async function runSyncCollectionRound(
  db: Db,
  client: CarddavClient,
  addressBook: AddressBookRow,
  collectionUrl: string,
  syncToken: string | undefined,
  args: SyncCarddavContactsArgs,
): Promise<void> {
  const isFullWalk = syncToken === undefined;
  const result = await client.syncCollection({
    url: collectionUrl,
    syncToken,
    credentials: args.credentials,
  });

  const seen = new Set<string>();
  for (const vcard of result.changed) {
    await applyCarddavVcard(db, addressBook, args, vcard);
    seen.add(vcard.href);
  }
  await deleteCarddavContactsByHref(db, addressBook.id, result.deletedHrefs);

  if (isFullWalk) {
    const mirrored = await listCarddavHrefEtagsForAddressBook(db, addressBook.id);
    const stale = [...mirrored.keys()].filter((href) => !seen.has(href));
    await deleteCarddavContactsByHref(db, addressBook.id, stale);
  }

  // Absent only if a server's `sync-collection` response shape doesn't
  // parse the way this app expects — the next tick's "no stored token"
  // check then runs another full walk rather than silently going stale,
  // `people-sync.ts#runFullSync`'s own fallback for `nextSyncToken`.
  if (result.nextSyncToken) {
    await recordCarddavSync(db, addressBook.id, { syncToken: result.nextSyncToken });
  }
}

/**
 * The pre-RFC-6578 fallback (research doc §2.3): a cheap `getctag` compare
 * decides *whether* to do any more work at all, and only on a mismatch does
 * this fall through to a full `Depth:1` href+etag listing and a per-object
 * etag diff to work out *what* changed — `book.ctag` is already this tick's
 * own fresh value (`fetchAddressBooks`' own `supportedReportSet`+`getctag`
 * PROPFIND), so this never spends a second round trip re-reading it.
 */
async function runCtagSync(
  db: Db,
  client: CarddavClient,
  addressBook: AddressBookRow,
  discoveredCtag: string | undefined,
  args: SyncCarddavContactsArgs,
): Promise<void> {
  const collectionUrl = requireCollectionUrl(addressBook);
  const storedCtag = addressBook.carddavCtag ?? undefined;
  // Compared as strings unconditionally (research doc §8.1, `tsdav` issue
  // #200's own caution: a server can hand back a numeric-looking ctag a
  // loose comparison coerces wrong).
  if (storedCtag !== undefined && discoveredCtag !== undefined && storedCtag === discoveredCtag) {
    return;
  }

  const remote = await client.listHrefs({ url: collectionUrl, credentials: args.credentials });
  const mirrored = await listCarddavHrefEtagsForAddressBook(db, addressBook.id);

  const remoteHrefs = new Set(remote.map((entry) => entry.href));
  const changedHrefs = remote
    .filter((entry) => !mirrored.has(entry.href) || mirrored.get(entry.href) !== entry.etag)
    .map((entry) => entry.href);
  const deletedHrefs = [...mirrored.keys()].filter((href) => !remoteHrefs.has(href));

  if (changedHrefs.length > 0) {
    const fetched = await client.multiget({
      url: collectionUrl,
      hrefs: changedHrefs,
      credentials: args.credentials,
    });
    for (const vcard of fetched) await applyCarddavVcard(db, addressBook, args, vcard);
  }
  await deleteCarddavContactsByHref(db, addressBook.id, deletedHrefs);

  await recordCarddavSync(db, addressBook.id, { ctag: discoveredCtag });
}

/**
 * Upserts one fetched vCard and, best-effort, its embedded `PHOTO` into the
 * Blob Store (#213) — `contacts/microsoft/contacts-sync.ts#syncContactPhoto`'s
 * own tolerance: an unrecognised content type or a failed store never fails
 * the whole Contact upsert, and this never *clears* a previously-stored
 * photo just because a later round's vCard omits `PHOTO` (the same "no
 * photo-editing round trip" gap Graph's own sync already accepts).
 */
async function applyCarddavVcard(
  db: Db,
  addressBook: AddressBookRow,
  args: SyncCarddavContactsArgs,
  vcard: CarddavVCard,
): Promise<void> {
  const parsed = parseVcard(vcard.data);
  const contactId = await upsertCarddavContact(db, {
    addressBookId: addressBook.id,
    userId: args.userId,
    connectedAccountId: args.connectedAccountId,
    href: vcard.href,
    etag: vcard.etag,
    rawVcard: vcard.data,
    fields: parsed.fields,
    categories: parsed.categories,
  });

  if (!parsed.photo || !isContactPhotoMimeType(parsed.photo.mimeType)) return;
  try {
    await putContactPhoto(db, {
      userId: args.userId,
      contactId,
      bytes: parsed.photo.bytes,
      mimeType: parsed.photo.mimeType,
      maxBytes: CONTACT_PHOTO_MAX_BYTES,
    });
  } catch {
    // A transient store failure — the Contact itself is already mirrored
    // either way; the next sync tick tries the photo again.
  }
}

function requireCollectionUrl(addressBook: AddressBookRow): string {
  if (!addressBook.carddavCollectionUrl) {
    throw new Error(`Address Book ${addressBook.id} has no carddavCollectionUrl to sync against`);
  }
  return addressBook.carddavCollectionUrl;
}
