import type { CollectionDelta, MailAccount, Preference, Thread } from "@mail/shared";
import { DEFAULT_UNDO_SEND_DELAY_SECONDS, UNDO_SEND_DELAY_OPTIONS } from "@mail/shared";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { mailAccounts, syncTombstones, threads, users } from "../db/schema.js";
import { mailAccountRowsQuery, toWireMailAccount } from "../mail-accounts/store.js";
import { encodeSyncToken, resolveCursor } from "./sync-tokens.js";
import { toWireThread } from "./thread-projection.js";

/**
 * Computes one collection's answer for `POST /sync` (#37, ADR-0011): the
 * page of upserts/destroys since a state token, bucketed into
 * `created`/`updated`/`destroyed`, plus the next token to resume from.
 *
 * `syncMailAccountCollection` is User-scoped; `Thread`, `Label` and
 * `Composition` are per Mail Account. Each is a thin query dressed around the
 * shared `buildDelta` merge below, so a future `Preference` collection is the
 * same shape again, not a new mechanism.
 */

/** Entity cap per response (ADR-0011): generous enough an ordinary 30s poll never pages, bounded enough a first bootstrap can't return an 80k-thread account in one round trip. */
export const PAGE_SIZE = 500;

export interface SyncRevRow {
  syncRev: number;
  syncCreatedRev: number;
}

type MergedItem<Row> =
  | { kind: "upsert"; rev: number; row: Row }
  | { kind: "destroy"; rev: number; entityId: string };

/**
 * Merges a page of changed rows with a page of tombstones — both already
 * ordered ascending by the shared `sync_rev` sequence — into one
 * `CollectionDelta`. `null` means "nothing changed since a token this Client
 * has already persisted a `newState` for": the caller omits the collection
 * from the response entirely rather than sending an empty-but-present
 * result.
 *
 * A **bootstrap** (`token === null`) with zero rows is not that case, even
 * though it also has `!needsReset && items.length === 0` — the Client has no
 * prior `newState` for this collection yet (a User with no Mail Accounts, a
 * fresh Mail Account with no Threads), so it must still receive a delta
 * object carrying `newState` to persist, or it can never tell "I bootstrapped
 * and got nothing" from "I haven't asked yet". `token` is threaded through
 * only to draw that line; every other branch below is unchanged by it.
 *
 * Fetching `PAGE_SIZE + 1` from each side (both callers below) before this
 * runs is what makes the merge correct: the true globally-smallest
 * `PAGE_SIZE` items across both ordered streams are always contained within
 * the smallest `PAGE_SIZE + 1` of each individual stream, so this never has
 * to re-query to fill a page or to answer `hasMore` correctly.
 */
export function buildDelta<Row extends SyncRevRow, Payload>(args: {
  rows: Row[];
  tombstones: { entityId: string; syncRev: number }[];
  cursorRev: number;
  needsReset: boolean;
  /** The Client-supplied token this round answers, `null` on a bootstrap. */
  token: string | null;
  epoch?: number;
  toPayload: (row: Row) => Payload;
}): CollectionDelta<Payload> | null {
  const items: MergedItem<Row>[] = [
    ...args.rows.map((row): MergedItem<Row> => ({ kind: "upsert", rev: row.syncRev, row })),
    ...args.tombstones.map(
      (tombstone): MergedItem<Row> => ({
        kind: "destroy",
        rev: tombstone.syncRev,
        entityId: tombstone.entityId,
      }),
    ),
  ].sort((left, right) => left.rev - right.rev);

  const isBootstrap = args.token === null;
  if (!args.needsReset && !isBootstrap && items.length === 0) return null;

  const page = items.slice(0, PAGE_SIZE);
  const hasMore = items.length > PAGE_SIZE;

  const created: Payload[] = [];
  const updated: Payload[] = [];
  const destroyed: string[] = [];
  for (const item of page) {
    if (item.kind === "destroy") {
      destroyed.push(item.entityId);
      continue;
    }
    // A row's creation revision above the cursor means the Client has never
    // seen this id before; at or below, the Client already has it and this
    // is a change to an existing row.
    if (item.row.syncCreatedRev > args.cursorRev) created.push(args.toPayload(item.row));
    else updated.push(args.toPayload(item.row));
  }

  const lastItem = page[page.length - 1];
  const lastRev = lastItem ? lastItem.rev : Math.max(args.cursorRev, 0);

  return {
    created,
    updated,
    destroyed,
    newState: encodeSyncToken({ rev: lastRev, epoch: args.epoch }),
    hasMore,
    ...(args.needsReset ? { reset: true as const } : {}),
  };
}

/** `MailAccount`, User-scoped (ADR-0011): every Mail Account this User owns. */
export async function syncMailAccountCollection(
  db: Db,
  userId: string,
  token: string | null,
): Promise<CollectionDelta<MailAccount> | null> {
  const { rev: cursorRev, needsReset } = resolveCursor(token);

  const rows = await mailAccountRowsQuery(db)
    .where(and(eq(mailAccounts.userId, userId), gt(mailAccounts.syncRev, cursorRev)))
    .orderBy(asc(mailAccounts.syncRev))
    .limit(PAGE_SIZE + 1);

  // No route destroys a Mail Account yet, so this is always empty in
  // practice today — queried anyway so the day one exists, nothing here
  // needs to change.
  const tombstoneRows = needsReset
    ? []
    : await db
        .select({ entityId: syncTombstones.entityId, syncRev: syncTombstones.syncRev })
        .from(syncTombstones)
        .where(
          and(
            isNull(syncTombstones.mailAccountId),
            eq(syncTombstones.collection, "MailAccount"),
            gt(syncTombstones.syncRev, cursorRev),
          ),
        )
        .orderBy(asc(syncTombstones.syncRev))
        .limit(PAGE_SIZE + 1);

  return buildDelta({
    rows,
    tombstones: tombstoneRows,
    cursorRev,
    needsReset,
    token,
    toPayload: toWireMailAccount,
  });
}

export function toWirePreference(row: typeof users.$inferSelect): Preference {
  return {
    id: row.id,
    autoAdvanceEnabled: row.autoAdvanceEnabled,
    autoAdvanceDirection: row.autoAdvanceDirection,
    undoSendDelaySeconds: UNDO_SEND_DELAY_OPTIONS.includes(
      row.undoSendDelaySeconds as (typeof UNDO_SEND_DELAY_OPTIONS)[number],
    )
      ? (row.undoSendDelaySeconds as Preference["undoSendDelaySeconds"])
      : DEFAULT_UNDO_SEND_DELAY_SECONDS,
    homeTimeZone: row.homeTimeZone,
    contactsSortOrder: row.contactsSortOrder,
    answerNotificationsEnabled: row.answerNotificationsEnabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * `Preference`, User-scoped (#54, ADR-0011): exactly one row — this User's
 * own `users` row, projected down to the fields Preferences owns — so this is
 * the "a future `Preference` collection is the same shape again" this
 * module's own docstring promised: no windowing, no tombstones anyone will
 * ever emit (a User's own Preference row never disappears while they exist),
 * queried defensively the same way `MailAccount`'s is.
 */
export async function syncPreferenceCollection(
  db: Db,
  userId: string,
  token: string | null,
): Promise<CollectionDelta<Preference> | null> {
  const { rev: cursorRev, needsReset } = resolveCursor(token);

  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), gt(users.syncRev, cursorRev)))
    .orderBy(asc(users.syncRev))
    .limit(PAGE_SIZE + 1);

  const tombstoneRows = needsReset
    ? []
    : await db
        .select({ entityId: syncTombstones.entityId, syncRev: syncTombstones.syncRev })
        .from(syncTombstones)
        .where(
          and(
            isNull(syncTombstones.mailAccountId),
            eq(syncTombstones.collection, "Preference"),
            gt(syncTombstones.syncRev, cursorRev),
          ),
        )
        .orderBy(asc(syncTombstones.syncRev))
        .limit(PAGE_SIZE + 1);

  return buildDelta({
    rows,
    tombstones: tombstoneRows,
    cursorRev,
    needsReset,
    token,
    toPayload: toWirePreference,
  });
}

/**
 * `Thread`, scoped to one Mail Account (ADR-0011). `currentEpoch` is the
 * account's `threadsEpoch` (`db/schema.ts`) at the moment of this call: a
 * token issued under an older epoch means a Folder under this account has
 * been rebuilt from a UIDVALIDITY change since, so this answers with
 * `reset: true` and a fresh full page rather than trusting `destroyed` to
 * cover a wipe that large.
 */
export async function syncThreadCollection(
  db: Db,
  mailAccountId: string,
  currentEpoch: number,
  token: string | null,
): Promise<CollectionDelta<Thread> | null> {
  const { rev: cursorRev, needsReset } = resolveCursor(token, currentEpoch);

  const rows = await db
    .select()
    .from(threads)
    .where(and(eq(threads.mailAccountId, mailAccountId), gt(threads.syncRev, cursorRev)))
    .orderBy(asc(threads.syncRev))
    .limit(PAGE_SIZE + 1);

  const tombstoneRows = needsReset
    ? []
    : await db
        .select({ entityId: syncTombstones.entityId, syncRev: syncTombstones.syncRev })
        .from(syncTombstones)
        .where(
          and(
            eq(syncTombstones.mailAccountId, mailAccountId),
            eq(syncTombstones.collection, "Thread"),
            gt(syncTombstones.syncRev, cursorRev),
          ),
        )
        .orderBy(asc(syncTombstones.syncRev))
        .limit(PAGE_SIZE + 1);

  return buildDelta({
    rows,
    tombstones: tombstoneRows,
    cursorRev,
    needsReset,
    token,
    epoch: currentEpoch,
    toPayload: toWireThread,
  });
}
