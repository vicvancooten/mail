import type { AddressBook, AddressBookCapabilityTableId } from "@mail/shared";
import { GOOGLE_ADDRESS_BOOK_NAME, generateUlid, LOCAL_ADDRESS_BOOK_NAME } from "@mail/shared";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { addressBooks } from "../db/schema.js";
import {
  countMirroredContacts,
  type DiscardedMirrorCounts,
  discardMirroredContacts,
} from "./mirror-discard.js";

export type AddressBookRow = typeof addressBooks.$inferSelect;

/**
 * Mints the User's one Local Address Book the first time anything asks for
 * it (#209, ADR-0026: "created on first use, never deletable") — the same
 * "insert-only, loser reads the winner's row back" race guard
 * `notifier/vapid-keys.ts#ensure` already uses for its own lazy singleton,
 * scoped down to one User instead of the whole instance. `onConflictDoNothing`
 * targets `address_books_user_local_key` (`db/schema.ts`'s own partial
 * unique index) via `target`+`where` (the partial index's own predicate,
 * without which Postgres cannot infer it), so two concurrent first syncs
 * from the same User can never mint two.
 *
 * Called at the top of the `AddressBook` collection's own `selectRows`
 * (`collection-registry.ts`) rather than at sign-up: a User who existed
 * before this ticket gets one on their very next sync, with no migration
 * backfill needed.
 *
 * Takes `Db | Tx` (#215): `unmirrorAddressBook`'s own Default-Address-Book
 * fallback needs this to run inside the same transaction as the `mirrored`
 * flip it follows — the same widening `calendars/store.ts#ensurePersonalCalendar`
 * already took for its own sibling call.
 */
export async function ensureLocalAddressBook(db: Db | Tx, userId: string): Promise<void> {
  await ensureLocalAddressBookId(db, userId);
}

/**
 * `ensureLocalAddressBook`'s own id-returning form (#210): `createContact`
 * (`sync/mutations.ts`) always writes into the caller's Local Address Book,
 * never one the Client names on the wire — this is what resolves it,
 * minting it first if this is the User's very first Contact-shaped write.
 * Takes `Db | Tx` (#215): `unmirrorAddressBook`'s own Default-Address-Book
 * fallback calls `ensureLocalAddressBook` inside its own transaction.
 */
export async function ensureLocalAddressBookId(db: Db | Tx, userId: string): Promise<string> {
  await db
    .insert(addressBooks)
    .values({
      id: generateUlid(),
      userId,
      connectedAccountId: null,
      name: LOCAL_ADDRESS_BOOK_NAME,
      capabilityTableId: "local",
      mirrored: false,
      isDefault: true,
    })
    .onConflictDoNothing({
      target: addressBooks.userId,
      where: sql`${addressBooks.connectedAccountId} is null`,
    });
  const [row] = await db
    .select({ id: addressBooks.id })
    .from(addressBooks)
    .where(and(eq(addressBooks.userId, userId), isNull(addressBooks.connectedAccountId)))
    .limit(1);
  // The insert above either created this row or found it already there via
  // `onConflictDoNothing` — either way it exists by the time this reads it.
  if (!row) throw new Error(`local address book missing for user ${userId} after ensure`);
  return row.id;
}

/**
 * The Local Address Book only (`connectedAccountId is null`) — the User
 * scope's own slice of this collection. A mirrored book with the same
 * `userId` rides its Connected Account's own scope instead
 * (`selectAddressBooksForConnectedAccount` below), never both: "same row
 * shape, two token keys" (#209's own acceptance line) means each row
 * appears on exactly one of them.
 */
export function selectAddressBooksForUser(db: Db, userId: string, cursorRev: number) {
  return db
    .select()
    .from(addressBooks)
    .where(
      and(
        eq(addressBooks.userId, userId),
        isNull(addressBooks.connectedAccountId),
        gt(addressBooks.syncRev, cursorRev),
      ),
    )
    .orderBy(asc(addressBooks.syncRev));
}

/** Every Address Book mirrored from one Connected Account — `selectAddressBooksForUser`'s sibling for the connectedAccount scope. Empty until an upstream adapter creates one (#214+). */
export function selectAddressBooksForConnectedAccount(
  db: Db,
  connectedAccountId: string,
  cursorRev: number,
) {
  return db
    .select()
    .from(addressBooks)
    .where(
      and(
        eq(addressBooks.connectedAccountId, connectedAccountId),
        gt(addressBooks.syncRev, cursorRev),
      ),
    )
    .orderBy(asc(addressBooks.syncRev));
}

/** Every Address Book id belonging to one Connected Account — the removal path's own read (`connected-accounts/removal.ts`), ahead of deleting them. Takes `Db | Tx`: that removal runs inside its own transaction. */
export async function listAddressBookIdsForConnectedAccount(
  db: Db | Tx,
  connectedAccountId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: addressBooks.id })
    .from(addressBooks)
    .where(eq(addressBooks.connectedAccountId, connectedAccountId));
  return rows.map((row) => row.id);
}

/**
 * Mints a Connected Account's one mirrored Google Address Book the first
 * time its sync loop ticks for that account (#214, ADR-0026, ADR-0031:
 * `mirrored` defaults true here — unlike the Local Address Book, a Google
 * Address Book with no reason to distrust it starts mirrored). Same
 * "insert-only, loser reads the winner's row back" race guard as
 * `ensureLocalAddressBook` above, targeting `address_books_connected_account_google_key`
 * (`db/schema.ts`'s own partial unique index, scoped to `capabilityTableId
 * = 'google'`) — Google only ever has the signed-in User's own one contacts
 * collection, so this is idempotent per account rather than per (account,
 * upstream book).
 */
export async function ensureGoogleAddressBook(
  db: Db,
  args: { userId: string; connectedAccountId: string },
): Promise<AddressBookRow> {
  await db
    .insert(addressBooks)
    .values({
      id: generateUlid(),
      userId: args.userId,
      connectedAccountId: args.connectedAccountId,
      name: GOOGLE_ADDRESS_BOOK_NAME,
      capabilityTableId: "google",
      mirrored: true,
      isDefault: false,
    })
    .onConflictDoNothing({
      target: addressBooks.connectedAccountId,
      where: sql`${addressBooks.capabilityTableId} = 'google'`,
    });

  const [row] = await db
    .select()
    .from(addressBooks)
    .where(
      and(
        eq(addressBooks.connectedAccountId, args.connectedAccountId),
        eq(addressBooks.capabilityTableId, "google"),
      ),
    )
    .limit(1);
  if (!row) {
    // Can only happen if the insert above raced a concurrent deletion of the
    // very row it just lost the `onConflictDoNothing` race to — the Facet
    // that owns this account's Contacts mirror would have to have been torn
    // down between this function's two queries.
    throw new Error(
      `ensureGoogleAddressBook: no Address Book found for Connected Account ${args.connectedAccountId} after ensure`,
    );
  }
  return row;
}

/**
 * The sync-token bookkeeping half of a full `connections.list` walk
 * (#214): stamps the freshly-minted `nextSyncToken` and resets
 * `googleSyncTokenMintedAt` to `now` — the clock the People API's
 * documented 7-day expiry runs against
 * (`docs/research/0010-contacts-sync-and-model.md` §1.1), so an
 * incremental round in between never pushes this forward (`recordGoogleIncrementalSyncToken` below doesn't touch it).
 */
export async function recordGoogleFullSync(
  db: Db,
  addressBookId: string,
  syncToken: string,
  now: Date,
): Promise<void> {
  await db
    .update(addressBooks)
    .set({ googleSyncToken: syncToken, googleSyncTokenMintedAt: now, updatedAt: now })
    .where(eq(addressBooks.id, addressBookId));
}

/** An incremental round's own new `nextSyncToken` — leaves `googleSyncTokenMintedAt` alone (this function's sibling `recordGoogleFullSync`'s own doc comment). */
export async function recordGoogleIncrementalSyncToken(
  db: Db,
  addressBookId: string,
  syncToken: string,
): Promise<void> {
  await db
    .update(addressBooks)
    .set({ googleSyncToken: syncToken, updatedAt: new Date() })
    .where(eq(addressBooks.id, addressBookId));
}

/**
 * The Default Address Book (#211): flips `isDefault` so it lands on exactly
 * one row for this User, across every Origin — `false` on whichever row
 * held it before, `true` on `addressBookId`, both stamped so the delta sync
 * `bump_sync_rev` trigger picks up each row it actually touches. Returns
 * `false` for an `addressBookId` this User does not own (a stale id, or
 * another User's row entirely), which `mutations.ts` turns into a rejected
 * outcome rather than silently doing nothing.
 */
export async function setDefaultAddressBook(
  db: Db,
  userId: string,
  addressBookId: string,
): Promise<boolean> {
  const [book] = await db
    .select({ id: addressBooks.id })
    .from(addressBooks)
    .where(and(eq(addressBooks.id, addressBookId), eq(addressBooks.userId, userId)))
    .limit(1);
  if (!book) return false;

  const now = new Date();
  await db
    .update(addressBooks)
    .set({ isDefault: false, updatedAt: now })
    .where(and(eq(addressBooks.userId, userId), eq(addressBooks.isDefault, true)));
  await db
    .update(addressBooks)
    .set({ isDefault: true, updatedAt: now })
    .where(eq(addressBooks.id, addressBookId));
  return true;
}

/** Drops a stale/expired sync token (an `EXPIRED_SYNC_TOKEN` response) so the next tick falls back to a full walk — leaves `googleSyncTokenMintedAt` for that full walk's own `recordGoogleFullSync` call to overwrite. */
export async function clearGoogleSyncToken(db: Db, addressBookId: string): Promise<void> {
  await db
    .update(addressBooks)
    .set({ googleSyncToken: null, updatedAt: new Date() })
    .where(eq(addressBooks.id, addressBookId));
}

/**
 * Mints or refreshes one Graph contact folder's own mirrored Address Book
 * (#227, ADR-0026, ADR-0031): unlike `ensureGoogleAddressBook`, a Connected
 * Account legitimately mirrors several of these — one per discovered
 * folder — so this is keyed on (`connectedAccountId`, `folderId`), the
 * partial unique index `db/schema.ts` scopes to `capabilityTableId =
 * 'microsoft'`. `onConflictDoUpdate` rather than `onConflictDoNothing`
 * (`ensureGoogleAddressBook`'s own choice): a folder's `displayName` can be
 * renamed upstream between discovery walks, and this keeps `name` current
 * without ever touching `mirrored`/`isDefault` — a User's own unmirror
 * decision (#215) survives a rediscovery the same way it would for Google.
 * `mirrored` defaults `true` on first insert only, matching
 * `ensureGoogleAddressBook`'s own "no reason to distrust it yet" reasoning.
 */
export async function ensureMicrosoftAddressBook(
  db: Db,
  args: { userId: string; connectedAccountId: string; folderId: string; name: string },
): Promise<AddressBookRow> {
  await db
    .insert(addressBooks)
    .values({
      id: generateUlid(),
      userId: args.userId,
      connectedAccountId: args.connectedAccountId,
      name: args.name,
      capabilityTableId: "microsoft",
      mirrored: true,
      isDefault: false,
      microsoftFolderId: args.folderId,
    })
    .onConflictDoUpdate({
      target: [addressBooks.connectedAccountId, addressBooks.microsoftFolderId],
      // The partial index's own predicate (`db/schema.ts`) has to ride
      // along here too, the same "Postgres cannot infer a partial index's
      // arbiter without it" reasoning `upsertGoogleContact`'s own
      // `targetWhere` already documents.
      targetWhere: sql`${addressBooks.capabilityTableId} = 'microsoft' and ${addressBooks.microsoftFolderId} is not null`,
      set: { name: args.name, updatedAt: new Date() },
    });

  const [row] = await db
    .select()
    .from(addressBooks)
    .where(
      and(
        eq(addressBooks.connectedAccountId, args.connectedAccountId),
        eq(addressBooks.capabilityTableId, "microsoft"),
        eq(addressBooks.microsoftFolderId, args.folderId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `ensureMicrosoftAddressBook: no Address Book found for Connected Account ${args.connectedAccountId} folder ${args.folderId} after ensure`,
    );
  }
  return row;
}

/** Every Address Book this Connected Account mirrors from Graph (#227) — `contacts-sync.ts`'s own "which folders are already known" read, ahead of a discovery walk's reconciliation. */
export async function listMicrosoftAddressBooksForConnectedAccount(
  db: Db,
  connectedAccountId: string,
): Promise<AddressBookRow[]> {
  return db
    .select()
    .from(addressBooks)
    .where(
      and(
        eq(addressBooks.connectedAccountId, connectedAccountId),
        eq(addressBooks.capabilityTableId, "microsoft"),
      ),
    );
}

/** A delta round's own new `@odata.deltaLink` (#227) — stamped after every successful round, full or incremental alike, since Graph's delta model draws no distinction between the two the way Google's sync token does. */
export async function recordMicrosoftDeltaLink(
  db: Db,
  addressBookId: string,
  deltaLink: string,
): Promise<void> {
  await db
    .update(addressBooks)
    .set({ microsoftDeltaLink: deltaLink, updatedAt: new Date() })
    .where(eq(addressBooks.id, addressBookId));
}

/** Drops a stale delta link (a `410 Gone`/resync-required response) so the next round calls `/contacts/delta` fresh — which, per Graph's own model, walks the whole folder again rather than needing a distinct "full sync" call. */
export async function clearMicrosoftDeltaLink(db: Db, addressBookId: string): Promise<void> {
  await db
    .update(addressBooks)
    .set({ microsoftDeltaLink: null, updatedAt: new Date() })
    .where(eq(addressBooks.id, addressBookId));
}

/**
 * Mints or refreshes one CardDAV collection's own mirrored Address Book
 * (#226) — `ensureMicrosoftAddressBook`'s own shape, keyed on
 * (`connectedAccountId`, `carddavCollectionUrl`) the same "several mirrored
 * books per account" reason `microsoftFolderId` already is.
 * `onConflictDoUpdate` keeps `name` current across a rediscovery the same
 * way a Graph folder rename does, without ever touching `mirrored`/
 * `isDefault` — a User's own unmirror decision (#215) survives it. `mirrored`
 * defaults `true` on first insert only (ADR-0031's "no reason to distrust it
 * yet", the same default every upstream adapter's own `ensure*` gives).
 */
export async function ensureCarddavAddressBook(
  db: Db,
  args: { userId: string; connectedAccountId: string; collectionUrl: string; name: string },
): Promise<AddressBookRow> {
  await db
    .insert(addressBooks)
    .values({
      id: generateUlid(),
      userId: args.userId,
      connectedAccountId: args.connectedAccountId,
      name: args.name,
      capabilityTableId: "caldav_carddav",
      mirrored: true,
      isDefault: false,
      carddavCollectionUrl: args.collectionUrl,
    })
    .onConflictDoUpdate({
      target: [addressBooks.connectedAccountId, addressBooks.carddavCollectionUrl],
      targetWhere: sql`${addressBooks.capabilityTableId} = 'caldav_carddav' and ${addressBooks.carddavCollectionUrl} is not null`,
      set: { name: args.name, updatedAt: new Date() },
    });

  const [row] = await db
    .select()
    .from(addressBooks)
    .where(
      and(
        eq(addressBooks.connectedAccountId, args.connectedAccountId),
        eq(addressBooks.capabilityTableId, "caldav_carddav"),
        eq(addressBooks.carddavCollectionUrl, args.collectionUrl),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `ensureCarddavAddressBook: no Address Book found for Connected Account ${args.connectedAccountId} collection ${args.collectionUrl} after ensure`,
    );
  }
  return row;
}

/** Every Address Book this Connected Account mirrors from CardDAV (#226) — `contacts-sync.ts`'s own "which collections are already known" read, ahead of a discovery walk's reconciliation, `listMicrosoftAddressBooksForConnectedAccount`'s own shape. */
export async function listCarddavAddressBooksForConnectedAccount(
  db: Db,
  connectedAccountId: string,
): Promise<AddressBookRow[]> {
  return db
    .select()
    .from(addressBooks)
    .where(
      and(
        eq(addressBooks.connectedAccountId, connectedAccountId),
        eq(addressBooks.capabilityTableId, "caldav_carddav"),
      ),
    );
}

/**
 * Stamps a `sync-collection` round's own new `sync-token` (#226) — a full
 * listing's own first token, or an incremental round's next one, both drive
 * off this one setter since (unlike Google's minted-at 7-day floor) RFC 6578
 * gives CardDAV no equivalent expiry clock to track alongside it.
 * `carddavCtag` is stamped in the same write whenever the caller has a fresh
 * one to hand (the ctag-fallback path's own poll, or a webdav round that
 * happened to see one too) so both columns never drift out of step.
 */
export async function recordCarddavSync(
  db: Db,
  addressBookId: string,
  args: { syncToken?: string; ctag?: string },
): Promise<void> {
  await db
    .update(addressBooks)
    .set({
      ...(args.syncToken !== undefined ? { carddavSyncToken: args.syncToken } : {}),
      ...(args.ctag !== undefined ? { carddavCtag: args.ctag } : {}),
      updatedAt: new Date(),
    })
    .where(eq(addressBooks.id, addressBookId));
}

/** Drops a stale/rejected sync-token (`CarddavSyncTokenInvalidError`) so the next round runs a full listing instead — `clearMicrosoftDeltaLink`'s own shape. */
export async function clearCarddavSyncToken(db: Db, addressBookId: string): Promise<void> {
  await db
    .update(addressBooks)
    .set({ carddavSyncToken: null, updatedAt: new Date() })
    .where(eq(addressBooks.id, addressBookId));
}

/**
 * Which `ContactCapabilityTable` (`@mail/shared#contacts.ts`) a Contact's
 * own Address Book draws against (#227) — `sync/mutations.ts`'s own
 * write-path read, deciding whether `createContact`/`updateContact`/
 * `deleteContact` owe Graph a push (`contacts/store.ts`'s own outbox
 * helpers) without needing the whole row.
 */
export async function addressBookCapabilityTableId(
  db: Db | Tx,
  addressBookId: string,
): Promise<AddressBookCapabilityTableId | null> {
  const [row] = await db
    .select({ capabilityTableId: addressBooks.capabilityTableId })
    .from(addressBooks)
    .where(eq(addressBooks.id, addressBookId))
    .limit(1);
  return row?.capabilityTableId ?? null;
}

/**
 * One Address Book this User owns, of any Origin — `contacts/store.ts#contactRowForUser`'s
 * own shape, generalized to this collection: `createContact`'s (#225) target
 * validation, now that it can name any Address Book the User owns rather
 * than always resolving to the caller's own Local one
 * (`sync.ts#userMutationIntentSchema`'s own doc comment on that intent).
 */
export async function addressBookRowForUser(
  db: Db | Tx,
  userId: string,
  addressBookId: string,
): Promise<AddressBookRow | null> {
  const [row] = await db
    .select()
    .from(addressBooks)
    .where(and(eq(addressBooks.id, addressBookId), eq(addressBooks.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** No Address Book row exists for this User with this id — a bad id, or someone else's book. */
export class AddressBookNotFoundError extends Error {
  constructor(id: string) {
    super(`AddressBook ${id} not found`);
    this.name = "AddressBookNotFoundError";
  }
}

/**
 * The `mirrored` checklist only ever applies to a Connected Account's own
 * Address Book (#215's own acceptance line, `addressBookSchema`'s own
 * "always `false` until an upstream adapter exists" doc comment implies the
 * inverse for the Local book: there is no checklist entry to turn it off
 * from) — thrown for the Local Address Book's id passed to
 * `unmirrorAddressBook`/`mirrorAddressBook`.
 */
export class AddressBookNotMirrorableError extends Error {
  constructor(id: string) {
    super(`AddressBook ${id} is not a Connected Account's Address Book`);
    this.name = "AddressBookNotMirrorableError";
  }
}

async function getOwnConnectedAccountAddressBook(
  db: Db | Tx,
  userId: string,
  id: string,
): Promise<AddressBookRow> {
  const [row] = await db
    .select()
    .from(addressBooks)
    .where(and(eq(addressBooks.id, id), eq(addressBooks.userId, userId)))
    .limit(1);
  if (!row) throw new AddressBookNotFoundError(id);
  if (row.connectedAccountId === null) throw new AddressBookNotMirrorableError(id);
  return row;
}

/** The checklist's confirm dialog's preview, before anything is actually discarded — see `mirror-discard.ts#countMirroredContacts`'s own doc comment. */
export async function unmirrorAddressBookImpact(
  db: Db,
  userId: string,
  id: string,
): Promise<DiscardedMirrorCounts> {
  await getOwnConnectedAccountAddressBook(db, userId, id);
  return countMirroredContacts(db, id);
}

export interface UnmirrorAddressBookResult {
  addressBook: AddressBookRow;
  discarded: DiscardedMirrorCounts;
}

/**
 * Unmirroring (#215's own acceptance line): "confirmed, immediate, no
 * Undo; the row stays so it can be re-mirrored." Deliberately **not** an
 * Optimistic Action — there is no queued intent, no inverse to replay; this
 * runs synchronously in the request that calls it, inside one transaction
 * with the discard it triggers, so a crash mid-way never leaves
 * `mirrored: false` with the Contacts still sitting there (or vice versa).
 *
 * Idempotent: calling this on an already-unmirrored Address Book discards
 * nothing a second time (there is nothing left to discard) and still
 * succeeds — a User double-clicking the checklist entry mid-request never
 * sees an error for it.
 *
 * `googleSyncToken`/`googleSyncTokenMintedAt`/`carddavSyncToken`/
 * `carddavCtag` are reset alongside `mirrored` so a later re-mirror starts
 * each adapter's own "no stored token" full-walk fresh, rather than resuming
 * a cursor for data that no longer exists locally — harmless no-ops for
 * whichever pair this Address Book's own Origin never populated.
 */
export async function unmirrorAddressBook(
  db: Db,
  userId: string,
  id: string,
): Promise<UnmirrorAddressBookResult> {
  return db.transaction(async (tx) => {
    const row = await getOwnConnectedAccountAddressBook(tx, userId, id);
    const discarded = row.mirrored ? await discardMirroredContacts(tx, id) : { contacts: 0 };

    await tx
      .update(addressBooks)
      .set({
        mirrored: false,
        googleSyncToken: null,
        googleSyncTokenMintedAt: null,
        carddavSyncToken: null,
        carddavCtag: null,
        isDefault: false,
        updatedAt: new Date(),
      })
      .where(eq(addressBooks.id, id));

    if (row.isDefault) {
      // #215's own acceptance line: "A Default Address Book in an
      // unmirrored book falls back to Local silently" — `ensureLocalAddressBook`
      // covers a User who has never opened the Contacts App (so has no
      // Local Address Book yet either).
      await ensureLocalAddressBook(tx, userId);
      const [localBook] = await tx
        .select()
        .from(addressBooks)
        .where(and(eq(addressBooks.userId, userId), isNull(addressBooks.connectedAccountId)))
        .limit(1);
      if (localBook) {
        await tx
          .update(addressBooks)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(addressBooks.id, localBook.id));
      }
    }

    const [updated] = await tx.select().from(addressBooks).where(eq(addressBooks.id, id)).limit(1);
    if (!updated) throw new Error(`AddressBook ${id} disappeared mid-transaction`);
    return { addressBook: updated, discarded };
  });
}

/**
 * Re-mirroring: flips `mirrored` back on so the next poll tick's sync
 * cadence picks this Address Book back up. Idempotent the same way
 * `unmirrorAddressBook` is.
 */
export async function mirrorAddressBook(
  db: Db,
  userId: string,
  id: string,
): Promise<AddressBookRow> {
  const row = await getOwnConnectedAccountAddressBook(db, userId, id);
  if (row.mirrored) return row;

  await db
    .update(addressBooks)
    .set({ mirrored: true, updatedAt: new Date() })
    .where(eq(addressBooks.id, id));
  const [updated] = await db.select().from(addressBooks).where(eq(addressBooks.id, id)).limit(1);
  if (!updated) throw new Error(`AddressBook ${id} disappeared mid-update`);
  return updated;
}

/** `origin` (`@mail/shared#originSchema`) is derived here, never stored: `connectedAccountId` null means Local, set means the mirrored Connected Account. */
export function toWireAddressBook(row: AddressBookRow): AddressBook {
  return {
    id: row.id,
    name: row.name,
    origin:
      row.connectedAccountId === null
        ? { kind: "local" }
        : { kind: "connectedAccount", connectedAccountId: row.connectedAccountId },
    mirrored: row.mirrored,
    isDefault: row.isDefault,
    capabilityTableId: row.capabilityTableId,
    createdAt: row.createdAt.toISOString(),
  };
}
