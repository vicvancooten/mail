import {
  clearGoogleSyncToken,
  ensureGoogleAddressBook,
  recordGoogleFullSync,
  recordGoogleIncrementalSyncToken,
} from "../../address-books/store.js";
import type { Db } from "../../db/client.js";
import {
  deleteGoogleContactsByResourceName,
  listGoogleResourceNamesForAddressBook,
  upsertGoogleContact,
} from "../store.js";
import { type GooglePeopleClient, GoogleSyncTokenExpiredError } from "./client.js";

/**
 * The one Google People API `personFields` mask this ticket ever sends
 * (#214, research doc §1.1: "the `personFields` mask ... must be reused
 * verbatim for every delta call built on its token"). Every family
 * `GOOGLE_CONTACT_CAPABILITY_TABLE` (`@mail/shared#contacts.ts`) declares
 * held, plus `memberships` (contact groups, rendered read-only by a later
 * ticket) and `metadata` (`metadata.deleted`, the tombstone signal an
 * incremental round surfaces). Changing this constant changes the request
 * shape every stored `googleSyncToken` was minted against — a live token
 * would have to be dropped (`clearGoogleSyncToken`) rather than reused
 * across a change.
 */
export const GOOGLE_PERSON_FIELDS = [
  "metadata",
  "names",
  "nicknames",
  "emailAddresses",
  "phoneNumbers",
  "addresses",
  "organizations",
  "biographies",
  "birthdays",
  "photos",
  "memberships",
  "urls",
  "userDefined",
].join(",");

/** The People API's own documented sync-token lifetime (research doc §1.1: "Sync tokens expire 7 days after the full sync") — the floor this ticket forces a full resync at regardless of token health. */
export const GOOGLE_FULL_RESYNC_INTERVAL_MS = 7 * 24 * 60 * 60_000;

export interface SyncGoogleContactsArgs {
  userId: string;
  connectedAccountId: string;
  accessToken: string;
}

/**
 * Mirrors one Connected Account's Google contacts whole, per this ticket's
 * own sync loop per #214/research doc §1.1: a full `connections.list` walk
 * mints a fresh `syncToken` when none is stored or the stored one has
 * crossed the 7-day floor; otherwise an incremental round applies just the
 * delta, falling back to a full walk in the same tick on
 * `EXPIRED_SYNC_TOKEN`. The one caller today is `poll-loop.ts`'s own tick,
 * once per Connected Account with an active Contacts Facet; a future
 * "immediate pull" route (Opening the Contacts App or a Person Page, this
 * ticket's own acceptance line) is this same function, called on demand
 * instead of on the loop's own schedule — see this ticket's closing
 * comment for why that route isn't wired yet.
 */
export async function syncGoogleContactsForAccount(
  db: Db,
  client: GooglePeopleClient,
  args: SyncGoogleContactsArgs,
  now: Date = new Date(),
): Promise<void> {
  const addressBook = await ensureGoogleAddressBook(db, {
    userId: args.userId,
    connectedAccountId: args.connectedAccountId,
  });

  // #215's own acceptance line: "the row stays so it can be re-mirrored" —
  // an unmirrored Address Book already had its Contacts discarded at the
  // moment of unmirroring (`address-books/store.ts#unmirrorAddressBook`);
  // nothing here should recreate them on the next tick. Checked fresh every
  // tick (never cached) so re-mirroring resumes sync with no special case
  // beyond this reading `mirrored: true` again.
  if (!addressBook.mirrored) return;

  const syncToken = addressBook.googleSyncToken;
  const tokenAgeMs = addressBook.googleSyncTokenMintedAt
    ? now.getTime() - addressBook.googleSyncTokenMintedAt.getTime()
    : Number.POSITIVE_INFINITY;
  const needsFullSync = !syncToken || tokenAgeMs >= GOOGLE_FULL_RESYNC_INTERVAL_MS;

  if (needsFullSync || !syncToken) {
    await runFullSync(db, client, addressBook.id, args, now);
    return;
  }

  try {
    await runIncrementalSync(db, client, addressBook.id, syncToken, args);
  } catch (err) {
    if (!(err instanceof GoogleSyncTokenExpiredError)) throw err;
    // research doc §1.1: "In the case of such an error clients should make
    // a full sync request without a `syncToken`" — never retried as if
    // transient.
    await clearGoogleSyncToken(db, addressBook.id);
    await runFullSync(db, client, addressBook.id, args, now);
  }
}

/**
 * A full walk is the definitive membership list for this round: every
 * upstream `resourceName` it doesn't see is a Contact this Address Book no
 * longer has (deleted, or unshared) and gets tombstoned, the same
 * "additive-safe" posture the sibling Calendar epic's Google mirror already
 * established for its own collection.
 */
async function runFullSync(
  db: Db,
  client: GooglePeopleClient,
  addressBookId: string,
  args: SyncGoogleContactsArgs,
  now: Date,
): Promise<void> {
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  do {
    const page = await client.listConnections(args.accessToken, {
      personFields: GOOGLE_PERSON_FIELDS,
      pageToken,
      requestSyncToken: true,
    });
    for (const person of page.connections) {
      // A full walk lists live people only per the API's own contract;
      // skipping a stray `deleted` row defensively rather than mirroring a
      // tombstone as if it were a real Contact.
      if (person.metadata?.deleted) continue;
      await upsertGoogleContact(db, {
        addressBookId,
        userId: args.userId,
        connectedAccountId: args.connectedAccountId,
        resourceName: person.resourceName,
        etag: person.etag,
        payload: person,
      });
      seen.add(person.resourceName);
    }
    pageToken = page.nextPageToken;
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
  } while (pageToken);

  const mirrored = await listGoogleResourceNamesForAddressBook(db, addressBookId);
  const stale = [...mirrored].filter((resourceName) => !seen.has(resourceName));
  await deleteGoogleContactsByResourceName(db, addressBookId, stale);

  // `nextSyncToken` is only absent if Google's response shape ever changes
  // out from under this — if so, the next tick's `needsFullSync` check
  // (no stored token) runs another full walk rather than silently going
  // stale.
  if (nextSyncToken) await recordGoogleFullSync(db, addressBookId, nextSyncToken, now);
}

/**
 * Applies one delta round: an updated Person upserts, a `metadata.deleted`
 * Person tombstones (research doc §1.1: "Deletions surface as normal
 * Person resources ... with `metadata.deleted: true`"). `syncToken` stays
 * fixed across every page of this round — only `pageToken` advances — per
 * the API's own "all other parameters must match" rule.
 */
async function runIncrementalSync(
  db: Db,
  client: GooglePeopleClient,
  addressBookId: string,
  syncToken: string,
  args: SyncGoogleContactsArgs,
): Promise<void> {
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  do {
    const page = await client.listConnections(args.accessToken, {
      personFields: GOOGLE_PERSON_FIELDS,
      pageToken,
      syncToken,
    });
    const deletedResourceNames: string[] = [];
    for (const person of page.connections) {
      if (person.metadata?.deleted) {
        deletedResourceNames.push(person.resourceName);
        continue;
      }
      await upsertGoogleContact(db, {
        addressBookId,
        userId: args.userId,
        connectedAccountId: args.connectedAccountId,
        resourceName: person.resourceName,
        etag: person.etag,
        payload: person,
      });
    }
    await deleteGoogleContactsByResourceName(db, addressBookId, deletedResourceNames);
    pageToken = page.nextPageToken;
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
  } while (pageToken);

  if (nextSyncToken) await recordGoogleIncrementalSyncToken(db, addressBookId, nextSyncToken);
}
