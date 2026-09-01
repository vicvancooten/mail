import type {
  CollectionDelta,
  Composition,
  Correspondent,
  Label,
  MailAccount,
  Preference,
  Thread,
} from "@mail/shared";
import Dexie from "dexie";
import {
  type CachedComposition,
  type CachedThread,
  DEFAULT_VIEW,
  type ListWindow,
  type LocalCache,
  listWindowKey,
  type ViewKey,
} from "./db.js";
import { localCache } from "./local-cache.js";
import { threadSortKey } from "./thread-sort-key.js";

/**
 * The base-row writer. **`sync/` is the only caller** (ADR-0010): components
 * read through `store/reads.ts` and write through the Optimistic Action
 * queue, and neither ever sees a Dexie table or a state token. Everything
 * here is a translation of one `POST /sync` collection delta into the
 * bounded working set ADR-0009 specifies, in a single transaction with the
 * state token it accounts for — so a round that dies mid-write can never
 * leave a token pointing past data that didn't land.
 */

/** ADR-0009's guaranteed floor: the newest ~500 Threads per view per Mail Account, always held. */
export const THREAD_WINDOW_FLOOR = 500;

/**
 * Trim only once a window has grown to twice its floor. The gap is what
 * stops a bootstrap from re-trimming on every page: at the Sync Backend's
 * 500-entity page size, this trims at most once per page and usually far
 * less, because once a cutoff exists the older pages are ignored outright.
 */
export const THREAD_WINDOW_HIGH_WATER = 2 * THREAD_WINDOW_FLOOR;

export const MAIL_ACCOUNT_TOKEN_KEY = "user:MailAccount";
export const PREFERENCE_TOKEN_KEY = "user:Preference";

export function threadTokenKey(mailAccountId: string): string {
  return `account:${mailAccountId}:Thread`;
}

export function labelTokenKey(mailAccountId: string): string {
  return `account:${mailAccountId}:Label`;
}

export function compositionTokenKey(mailAccountId: string): string {
  return `account:${mailAccountId}:Composition`;
}

export function correspondentTokenKey(mailAccountId: string): string {
  return `account:${mailAccountId}:Correspondent`;
}

export async function getSyncToken(key: string): Promise<string | null> {
  const row = await localCache().syncState.get(key);
  return row?.token ?? null;
}

/** Which Mail Accounts this Client asks for Thread deltas about: the ones it holds. */
export async function listCachedMailAccountIds(): Promise<string[]> {
  return localCache().mailAccounts.toCollection().primaryKeys();
}

export interface ApplyDeltaOptions {
  /**
   * True on the **first page of a `reset: true` replay** (ADR-0011): the
   * Client discards what it had for this collection before merging. Later
   * pages of the same replay carry `reset` too but must not clear again,
   * which is why this is the caller's call and not `delta.reset`.
   */
  replace: boolean;
}

/** `MailAccount`, User-scoped. Destroying one cascades to everything keyed by it. */
export async function applyMailAccountDelta(
  delta: CollectionDelta<MailAccount>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction(
    "rw",
    [
      db.mailAccounts,
      db.threads,
      db.labels,
      db.correspondents,
      db.compositions,
      db.listWindows,
      db.cachePins,
      db.syncState,
    ],
    async () => {
      if (replace) await db.mailAccounts.clear();
      await db.mailAccounts.bulkPut([...delta.created, ...delta.updated]);
      await deleteMailAccountData(db, delta.destroyed);
      await db.syncState.put({ key: MAIL_ACCOUNT_TOKEN_KEY, token: delta.newState });
    },
  );
}

/**
 * `Preference`, User-scoped (#54): exactly one row, so unlike every other
 * collection here there is no `mailAccountId` and nothing to bulk-delete —
 * `bulkPut` on a one-row page is simply "replace this Client's copy of the
 * User's own settings".
 */
export async function applyPreferenceDelta(
  delta: CollectionDelta<Preference>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.preferences, db.syncState], async () => {
    if (replace) await db.preferences.clear();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.preferences.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.preferences.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: PREFERENCE_TOKEN_KEY, token: delta.newState });
  });
}

/**
 * `Thread`, scoped to one Mail Account. This is where the working set is
 * bounded: a Thread below the window's cutoff that the Client has never held
 * is **ignored, never auto-fetched**, and a window grown past its high water
 * is trimmed back to the floor.
 */
export async function applyThreadDelta(
  mailAccountId: string,
  delta: CollectionDelta<Thread>,
  { replace }: ApplyDeltaOptions,
  view: ViewKey = DEFAULT_VIEW,
): Promise<void> {
  const db = localCache();
  await db.transaction(
    "rw",
    [db.threads, db.listWindows, db.cachePins, db.pendingMutations, db.syncState],
    async () => {
      let window = await loadWindow(db, mailAccountId, view);
      if (replace) {
        await db.threads.where("mailAccountId").equals(mailAccountId).delete();
        window = { ...window, oldestHeldSort: null, complete: true };
        await db.listWindows.put(window);
      }

      const upserts = [...delta.created, ...delta.updated];
      if (upserts.length > 0) {
        const pinned = await pinnedThreadIds(db, mailAccountId);
        const known = new Set(
          await db.threads
            .where("id")
            .anyOf(upserts.map((thread) => thread.id))
            .primaryKeys(),
        );
        const admitted: CachedThread[] = [];
        for (const thread of upserts) {
          const sortKey = threadSortKey(thread);
          // An already-held Thread is always re-written, even if its date
          // moved below the cutoff: leaving the stale row behind would show
          // the User an outdated list row until the next trim.
          const inWindow = window.oldestHeldSort === null || sortKey >= window.oldestHeldSort;
          if (inWindow || known.has(thread.id) || pinned.has(thread.id)) {
            admitted.push({ ...thread, sortKey });
          }
        }
        await db.threads.bulkPut(admitted);
      }

      if (delta.destroyed.length > 0) {
        await db.threads.bulkDelete(delta.destroyed);
        await db.cachePins.bulkDelete(delta.destroyed);
      }

      await trimWindow(db, window);
      await db.syncState.put({ key: threadTokenKey(mailAccountId), token: delta.newState });
    },
  );
}

/**
 * `Label`, scoped to one Mail Account (#43, ADR-0011). No windowing — unlike
 * `Thread` there is no bounded working set to maintain, a Mail Account has
 * at most a handful of Labels at PoC scope (no management UI to make many
 * of them), so every Label this account has is simply held in full.
 */
export async function applyLabelDelta(
  mailAccountId: string,
  delta: CollectionDelta<Label>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.labels, db.syncState], async () => {
    if (replace) await db.labels.where("mailAccountId").equals(mailAccountId).delete();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.labels.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.labels.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: labelTokenKey(mailAccountId), token: delta.newState });
  });
}

/**
 * `Correspondent`, scoped to one Mail Account (#49, compose-spec §Recipient
 * autocomplete). No windowing, the same as `Label`: the Sync Backend never
 * hands this Client more than the top ~500 by score in the first place
 * (`sync/correspondents.ts#capCorrespondents`), so "hold everything this
 * collection sends" already *is* "hold the top ~500" — there is nothing left
 * for the Client to trim.
 */
export async function applyCorrespondentDelta(
  mailAccountId: string,
  delta: CollectionDelta<Correspondent>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.correspondents, db.syncState], async () => {
    if (replace) await db.correspondents.where("mailAccountId").equals(mailAccountId).delete();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.correspondents.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.correspondents.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: correspondentTokenKey(mailAccountId), token: delta.newState });
  });
}

/**
 * `Composition`, scoped to one Mail Account (#46). The only delta whose rows
 * this Client also writes itself, so it is the only one with a merge rule:
 *
 * - **Send state is always the server's.** `status`, `submitAfter`,
 *   `sendError` and `sentAt` are overwritten unconditionally — that is the
 *   whole mechanism by which a Pending Send started on one device shows its
 *   countdown on another (ADR-0007).
 * - **Content is the Client's while a save is still queued.** A Composition
 *   with an unflushed `pendingComposeSaves` row holds text the server has not
 *   seen; taking the server's older copy would destroy exactly what ADR-0012
 *   says is worth code to prevent. Once the save lands there is no queued row
 *   and the server's copy is simply adopted, which is also how a cancel on
 *   another device hands this one the content to reopen the composer with.
 * - **`sendState` is cleared by any terminal server status,** so a marker
 *   left behind by a round trip this tab never saw the answer to cannot
 *   outlive the send it described.
 */
export async function applyCompositionDelta(
  mailAccountId: string,
  delta: CollectionDelta<Composition>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.compositions, db.pendingComposeSaves, db.syncState], async () => {
    if (replace) await db.compositions.where("mailAccountId").equals(mailAccountId).delete();

    for (const wire of [...delta.created, ...delta.updated]) {
      const local = await db.compositions.get(wire.id);
      const hasUnflushedEdit = (await db.pendingComposeSaves.get(wire.id)) !== undefined;
      await db.compositions.put(mergeComposition(wire, local, hasUnflushedEdit));
    }

    if (delta.destroyed.length > 0) {
      await db.compositions.bulkDelete(delta.destroyed);
      await db.pendingComposeSaves.bulkDelete(delta.destroyed);
    }
    await db.syncState.put({
      key: compositionTokenKey(mailAccountId),
      token: delta.newState,
    });
  });
}

function mergeComposition(
  wire: Composition,
  local: CachedComposition | undefined,
  hasUnflushedEdit: boolean,
): CachedComposition {
  const content =
    local && hasUnflushedEdit
      ? {
          subject: local.subject,
          document: local.document,
          to: local.to,
          cc: local.cc,
          bcc: local.bcc,
          inReplyTo: local.inReplyTo,
          references: local.references,
        }
      : {
          subject: wire.subject,
          document: wire.document,
          to: wire.to,
          cc: wire.cc,
          bcc: wire.bcc,
          inReplyTo: wire.inReplyTo,
          references: wire.references,
        };
  return {
    id: wire.id,
    mailAccountId: wire.mailAccountId,
    status: wire.status,
    ...content,
    version: wire.version,
    submitAfter: wire.submitAfter,
    sendError: wire.sendError,
    sentAt: wire.sentAt,
    sendState:
      wire.status === "draft" || wire.status === "sent" ? null : (local?.sendState ?? null),
    createdAt: local?.createdAt ?? wire.updatedAt,
    updatedAt: wire.updatedAt,
    // Server-owned, always — an attach/delete already lands optimistically
    // via `store/attachments.ts`'s own direct write the moment its HTTP call
    // resolves; this delta is simply the authoritative confirmation.
    attachments: wire.attachments,
  };
}

/**
 * Drops everything keyed to a Mail Account the User no longer has. Runs at
 * the end of a sync round rather than on the delta, because a `reset: true`
 * MailAccount replay only reveals what is gone once its last page lands.
 * A no-op until the MailAccount collection has bootstrapped at least once —
 * before that, an empty table means "not synced yet", not "no accounts".
 */
export async function pruneOrphanedMailAccountData(): Promise<void> {
  const db = localCache();
  if ((await getSyncToken(MAIL_ACCOUNT_TOKEN_KEY)) === null) return;

  await db.transaction(
    "rw",
    [
      db.mailAccounts,
      db.threads,
      db.labels,
      db.correspondents,
      db.compositions,
      db.listWindows,
      db.cachePins,
      db.syncState,
    ],
    async () => {
      const live = new Set(await db.mailAccounts.toCollection().primaryKeys());
      const held = new Set<string>();
      for (const window of await db.listWindows.toArray()) held.add(window.mailAccountId);
      for (const id of await db.threads.orderBy("mailAccountId").uniqueKeys()) {
        held.add(String(id));
      }
      const orphaned = [...held].filter((id) => !live.has(id));
      if (orphaned.length > 0) await deleteMailAccountData(db, orphaned);
    },
  );
}

async function deleteMailAccountData(db: LocalCache, mailAccountIds: string[]): Promise<void> {
  if (mailAccountIds.length === 0) return;
  await db.mailAccounts.bulkDelete(mailAccountIds);
  await db.threads.where("mailAccountId").anyOf(mailAccountIds).delete();
  await db.labels.where("mailAccountId").anyOf(mailAccountIds).delete();
  await db.correspondents.where("mailAccountId").anyOf(mailAccountIds).delete();
  await db.compositions.where("mailAccountId").anyOf(mailAccountIds).delete();
  await db.listWindows.where("mailAccountId").anyOf(mailAccountIds).delete();
  await db.cachePins.where("mailAccountId").anyOf(mailAccountIds).delete();
  await db.syncState.bulkDelete([
    ...mailAccountIds.map(threadTokenKey),
    ...mailAccountIds.map(labelTokenKey),
    ...mailAccountIds.map(correspondentTokenKey),
    ...mailAccountIds.map(compositionTokenKey),
  ]);
}

async function loadWindow(
  db: LocalCache,
  mailAccountId: string,
  view: ViewKey,
): Promise<ListWindow> {
  const key = listWindowKey(mailAccountId, view);
  const existing = await db.listWindows.get(key);
  if (existing) return existing;
  const created: ListWindow = { key, mailAccountId, view, oldestHeldSort: null, complete: true };
  await db.listWindows.put(created);
  return created;
}

async function pinnedThreadIds(db: LocalCache, mailAccountId: string): Promise<Set<string>> {
  return new Set(await db.cachePins.where("mailAccountId").equals(mailAccountId).primaryKeys());
}

/**
 * Truncates a window's bottom back to the floor. This is a write-path job,
 * never a read-path one (ADR-0009) — it is what keeps a bootstrap of an
 * 80k-Thread Mail Account from ever materializing 80k rows. The byte-budgeted
 * LRU over bodies, which has nothing to evict until bodies are cached, is the
 * idle-time half of eviction.
 *
 * Threads that fall out are
 * deleted outright *unless* the User has one open (a cache pin) or a queued
 * Optimistic Action names it — ADR-0009's never-evictable set. Those rows
 * survive outside the window, which is exactly what "opened Threads are
 * pinned into the entity cache regardless of age" means.
 */
async function trimWindow(db: LocalCache, window: ListWindow): Promise<void> {
  const inWindow = threadsInWindow(db, window);
  if ((await inWindow.count()) <= THREAD_WINDOW_HIGH_WATER) return;

  const [floorThread] = await threadsInWindow(db, window)
    .reverse()
    .offset(THREAD_WINDOW_FLOOR - 1)
    .limit(1)
    .toArray();
  if (!floorThread) return;
  const cutoff = floorThread.sortKey;

  const evicted = await db.threads
    .where("[mailAccountId+sortKey]")
    .between([window.mailAccountId, Dexie.minKey], [window.mailAccountId, cutoff], true, false)
    .primaryKeys();

  const exempt = await evictionExempt(db, window.mailAccountId, evicted);
  await db.threads.bulkDelete(evicted.filter((id) => !exempt.has(id)));

  await db.listWindows.put({ ...window, oldestHeldSort: cutoff, complete: false });
}

/** The never-evictable set for one candidate batch: open Threads and anything unsent user intent references. */
async function evictionExempt(
  db: LocalCache,
  mailAccountId: string,
  candidates: string[],
): Promise<Set<string>> {
  const exempt = await pinnedThreadIds(db, mailAccountId);
  const referenced = await db.pendingMutations
    .where("referencedThreadIds")
    .anyOf(candidates)
    .toArray();
  for (const mutation of referenced) {
    for (const threadId of mutation.referencedThreadIds) exempt.add(threadId);
  }
  return exempt;
}

/** The window's membership as an ordered range query — never a scan, so callers can rely on its order. */
export function threadsInWindow(db: LocalCache, window: ListWindow) {
  return db.threads
    .where("[mailAccountId+sortKey]")
    .between(
      [window.mailAccountId, window.oldestHeldSort ?? Dexie.minKey],
      [window.mailAccountId, Dexie.maxKey],
      true,
      true,
    );
}
