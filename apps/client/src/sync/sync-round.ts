import type {
  ComposeSave,
  MailAccount,
  NoteSave,
  QueuedMutation,
  QueuedUserMutation,
  SyncRequest,
  SyncResponse,
} from "@mail/shared";
import { setBadgeCount } from "../pwa/badge.js";
import {
  listQueuedComposeSaves,
  resolveComposeSaveOutcomes,
  resolveDiscardOutcomes,
  resolveSendOutcomes,
  toWireComposeSave,
} from "../store/compositions.js";
import { readMailAccounts, reconcileCacheSchema } from "../store/index.js";
import { listQueuedMutations, resolveMutationOutcomes } from "../store/mutation-queue.js";
import { listQueuedNoteSaves, resolveNoteSaveOutcomes, toWireNoteSave } from "../store/notes.js";
import {
  getSyncToken,
  listCachedConnectedAccountIds,
  listCachedMailAccountIds,
  pruneOrphanedAddressBookData,
  pruneOrphanedMailAccountData,
} from "../store/server-writes.js";
import {
  listQueuedUserMutations,
  resolveUserMutationOutcomes,
} from "../store/user-mutation-queue.js";
import {
  CONNECTED_ACCOUNT_COLLECTIONS,
  MAIL_ACCOUNT_COLLECTIONS,
  USER_COLLECTIONS,
} from "./collection-registry.js";
import { type PostSync, postSync } from "./sync-api.js";

/**
 * One round of `POST /sync`: request the collections this Client holds,
 * apply what comes back, and keep going while the Sync Backend says there is
 * more. `sync/` is the only holder of state tokens and the only thing that
 * writes base rows (ADR-0010) — it does the latter through
 * `store/server-writes.ts`, which is the module that owns Dexie.
 *
 * The Optimistic Action queue rides the round's **first** request only
 * (ADR-0011's third divergence: a mutation-flush response carries deltas
 * back in the same round trip) — a paginated bootstrap's later pages would
 * otherwise resend an already-flushed queue.
 */

/**
 * A runaway guard, not a page budget. `hasMore` means "call again
 * immediately" (ADR-0011) and a first bootstrap of a large Mail Account
 * legitimately pages many times; this only stops a server that never clears
 * the flag, and the next round picks up where this one stopped.
 */
const MAX_PAGES_PER_ROUND = 500;

export interface SyncRoundResult {
  /**
   * True when a schema bump is waiting on the Optimistic Action queue to
   * drain (ADR-0009). No collection deltas were fetched — the impending
   * wipe would only throw their tokens away — but the queue itself is
   * still flushed, which is what lets the wipe proceed on a later round
   * once it drains.
   */
  deferred: boolean;
  pages: number;
  /** True when at least one collection carried a change. */
  changed: boolean;
}

export async function runSyncRound(post: PostSync = postSync): Promise<SyncRoundResult> {
  const schema = await reconcileCacheSchema();
  if (schema.status === "deferred") {
    return { deferred: true, pages: await flushMutationsOnly(post), changed: false };
  }

  // A `reset: true` replay spans every page until `hasMore` goes false, and
  // only its *first* page discards what the Client had. Clearing on each
  // page would leave the cache holding the last page alone.
  const replaysStarted = new Set<string>();
  let pages = 0;
  let changed = false;
  // The app-icon badge (#53, ADR-0015): read off every page's response and
  // applied once, after the loop — not per page, which would call the
  // Badging API redundantly on a large multi-page bootstrap for no benefit
  // (every page of one round carries the same fresh value).
  let unreadInboxCount: number | undefined;

  while (pages < MAX_PAGES_PER_ROUND) {
    const request = await buildSyncRequest({
      includeCollections: true,
      includeMutations: pages === 0,
    });
    const askedAbout = new Set(Object.keys(request.mailAccounts ?? {}));
    const askedAboutConnectedAccounts = new Set(Object.keys(request.connectedAccounts ?? {}));
    const response = await post(request);
    pages += 1;
    if (response.user.unreadInboxCount !== undefined) {
      unreadInboxCount = response.user.unreadInboxCount;
    }

    if (pages === 1) {
      await applyMutationOutcomes(request, response);
      await applyComposeSaveOutcomes(request, response);
      await applyUserMutationOutcomes(request, response);
      await applyNoteSaveOutcomes(request, response);
    }

    let hasMore = false;

    for (const collection of USER_COLLECTIONS) {
      const delta = response.user[collection.wireKey];
      if (!delta) continue;
      changed = true;
      hasMore ||= delta.hasMore;
      await collection.apply(delta, {
        replace: startsReplay(replaysStarted, collection.tokenKey, delta.reset),
      });
    }

    for (const [mailAccountId, collections] of Object.entries(response.mailAccounts)) {
      for (const collection of MAIL_ACCOUNT_COLLECTIONS) {
        const delta = collections[collection.wireKey];
        if (!delta) continue;
        changed = true;
        hasMore ||= delta.hasMore;
        await collection.apply(mailAccountId, delta, {
          replace: startsReplay(replaysStarted, collection.tokenKey(mailAccountId), delta.reset),
        });
      }
    }

    // `AddressBook`/`Contact` (#209) — the same per-scope dispatch as the
    // Mail Account loop above, applied to a Connected Account's own slot
    // instead.
    for (const [connectedAccountId, collections] of Object.entries(response.connectedAccounts)) {
      for (const collection of CONNECTED_ACCOUNT_COLLECTIONS) {
        const delta = collections[collection.wireKey];
        if (!delta) continue;
        changed = true;
        hasMore ||= delta.hasMore;
        await collection.apply(connectedAccountId, delta, {
          replace: startsReplay(
            replaysStarted,
            collection.tokenKey(connectedAccountId),
            delta.reset,
          ),
        });
      }
    }

    // A first-ever boot learns its Mail Accounts (and, since #209, Connected
    // Accounts) from the round it is in the middle of. Going again
    // immediately is what makes the Threads of a freshly added Mail Account,
    // or the Address Books of a freshly added Connected Account, arrive on
    // the cold-boot sync rather than 30s later.
    const discovered = (await listCachedMailAccountIds()).some((id) => !askedAbout.has(id));
    const discoveredConnectedAccount = (await listCachedConnectedAccountIds()).some(
      (id) => !askedAboutConnectedAccounts.has(id),
    );
    if (!hasMore && !discovered && !discoveredConnectedAccount) break;
  }

  await pruneOrphanedMailAccountData();
  await pruneOrphanedAddressBookData();
  // "Set by the leader tab on every delta" (ADR-0015) — this is the leader
  // tab's own writer (the service worker's push handler is the other one,
  // `sw.ts`); both call the same idempotent `setBadgeCount` with a
  // server-computed absolute value, never a locally-derived delta.
  if (unreadInboxCount !== undefined) await setBadgeCount(unreadInboxCount);
  return { deferred: false, pages, changed };
}

/**
 * The schema-wipe-deferred path (ADR-0009): only the queue is sent, never a
 * collection token — those tokens are about to be discarded by the wipe
 * this drain unblocks, so advancing them here would be wasted work. `0`
 * pages (and no network call at all) when there is nothing to flush, which
 * is also the "every queued Mail Account is Needs Reauth" case: the queue
 * then correctly stays deferred forever, exactly as ADR-0011 asks.
 */
async function flushMutationsOnly(post: PostSync): Promise<number> {
  const request = await buildSyncRequest({ includeCollections: false, includeMutations: true });
  if (
    Object.keys(request.mailAccounts ?? {}).length === 0 &&
    (request.user?.mutations?.length ?? 0) === 0 &&
    (request.user?.noteSaves?.length ?? 0) === 0
  ) {
    return 0;
  }

  const response = await post(request);
  await applyMutationOutcomes(request, response);
  await applyComposeSaveOutcomes(request, response);
  await applyUserMutationOutcomes(request, response);
  await applyNoteSaveOutcomes(request, response);
  return 1;
}

/** Dequeues (and, on rejection, notifies) every mutation this request asked the server to flush. */
async function applyMutationOutcomes(request: SyncRequest, response: SyncResponse): Promise<void> {
  for (const [mailAccountId, requested] of Object.entries(request.mailAccounts ?? {})) {
    const queued = requested.mutations;
    if (!queued || queued.length === 0) continue;

    // Absent rather than empty means the server never answered for this
    // account this round (a defensive shape-mismatch, not expected in
    // practice) — the rows stay queued and retry next round rather than
    // being dequeued on a guess.
    const outcomes = response.mailAccounts?.[mailAccountId]?.mutations;
    if (!outcomes || outcomes.length === 0) continue;

    // The Composition intents (#46) need their *intent* to interpret the
    // outcome — "which Composition, and was this the cancel that lost the
    // race" — so they are paired up here, before `resolveMutationOutcomes`
    // dequeues and forgets them.
    const byId = new Map(queued.map((mutation) => [mutation.id, mutation.intent]));
    const pairedOutcomes = outcomes.flatMap((outcome) => {
      const intent = byId.get(outcome.id);
      return intent ? [{ intent, status: outcome.status, reason: outcome.reason }] : [];
    });
    await resolveSendOutcomes(pairedOutcomes);
    await resolveDiscardOutcomes(pairedOutcomes);
    await resolveMutationOutcomes(mailAccountId, queued, outcomes);
  }
}

/** Same shape as `applyMutationOutcomes`, for the User-scoped `Preference` queue (#54). */
async function applyUserMutationOutcomes(
  request: SyncRequest,
  response: SyncResponse,
): Promise<void> {
  const queued = request.user?.mutations;
  if (!queued || queued.length === 0) return;
  const outcomes = response.user.mutations;
  if (!outcomes || outcomes.length === 0) return;
  await resolveUserMutationOutcomes(outcomes);
}

/** Same shape as `applyUserMutationOutcomes`, for the `noteSaves` channel (#192, ADR-0023). */
async function applyNoteSaveOutcomes(request: SyncRequest, response: SyncResponse): Promise<void> {
  const queued = request.user?.noteSaves;
  if (!queued || queued.length === 0) return;
  const outcomes = response.user.noteSaves;
  if (!outcomes || outcomes.length === 0) return;
  await resolveNoteSaveOutcomes(queued, outcomes);
}

/** Same shape as `applyMutationOutcomes`, for Composition autosaves (ADR-0014, #45). */
async function applyComposeSaveOutcomes(
  request: SyncRequest,
  response: SyncResponse,
): Promise<void> {
  for (const [mailAccountId, requested] of Object.entries(request.mailAccounts ?? {})) {
    const queued = requested.composeSaves;
    if (!queued || queued.length === 0) continue;

    const outcomes = response.mailAccounts?.[mailAccountId]?.composeSaves;
    if (!outcomes || outcomes.length === 0) continue;
    await resolveComposeSaveOutcomes(mailAccountId, queued, outcomes);
  }
}

function startsReplay(started: Set<string>, key: string, reset: true | undefined): boolean {
  if (reset !== true) return false;
  const first = !started.has(key);
  started.add(key);
  return first;
}

type MailAccountRequestEntry = NonNullable<SyncRequest["mailAccounts"]>[string];
type ConnectedAccountRequestEntry = NonNullable<SyncRequest["connectedAccounts"]>[string];

interface BuildSyncRequestOptions {
  /** Whether to ask for `Thread`/`MailAccount` deltas at all. */
  includeCollections: boolean;
  /** Whether to gather this round's mutation flush. Only ever the round's first request. */
  includeMutations: boolean;
}

/**
 * `null` for a collection the Client holds nothing of yet — a bootstrap, not
 * the same thing as a stale token, which the server answers with `reset`.
 */
async function buildSyncRequest({
  includeCollections,
  includeMutations,
}: BuildSyncRequestOptions): Promise<SyncRequest> {
  const accounts = await readMailAccounts();
  const mailAccounts: NonNullable<SyncRequest["mailAccounts"]> = {};

  for (const account of accounts) {
    const entry: MailAccountRequestEntry = {};
    if (includeCollections) {
      for (const collection of MAIL_ACCOUNT_COLLECTIONS) {
        entry[collection.wireKey] = await getSyncToken(collection.tokenKey(account.id));
      }
    }
    if (includeMutations) {
      const mutations = await mutationsToFlush(account);
      if (mutations.length > 0) entry.mutations = mutations;
      const composeSaves = await composeSavesToFlush(account);
      if (composeSaves.length > 0) entry.composeSaves = composeSaves;
    }
    if (
      MAIL_ACCOUNT_COLLECTIONS.some((collection) => entry[collection.wireKey] !== undefined) ||
      entry.mutations !== undefined ||
      entry.composeSaves !== undefined
    ) {
      mailAccounts[account.id] = entry;
    }
  }

  // `AddressBook`/`Contact` (#209) — no mutations/composeSaves to gather
  // yet (no upstream adapter writes back, #214+), so this is just token
  // dispatch, the same shape the Mail Account loop above has minus its
  // queues.
  const connectedAccountIds = await listCachedConnectedAccountIds();
  const connectedAccounts: NonNullable<SyncRequest["connectedAccounts"]> = {};
  if (includeCollections) {
    for (const connectedAccountId of connectedAccountIds) {
      const entry: ConnectedAccountRequestEntry = {};
      for (const collection of CONNECTED_ACCOUNT_COLLECTIONS) {
        entry[collection.wireKey] = await getSyncToken(collection.tokenKey(connectedAccountId));
      }
      connectedAccounts[connectedAccountId] = entry;
    }
  }

  const user: NonNullable<SyncRequest["user"]> = {};
  if (includeCollections) {
    for (const collection of USER_COLLECTIONS) {
      user[collection.wireKey] = await getSyncToken(collection.tokenKey);
    }
  }
  if (includeMutations) {
    const userMutations = await userMutationsToFlush();
    if (userMutations.length > 0) user.mutations = userMutations;
    const noteSaves = await noteSavesToFlush();
    if (noteSaves.length > 0) user.noteSaves = noteSaves;
  }

  return {
    ...(Object.keys(user).length > 0 ? { user } : {}),
    mailAccounts,
    ...(Object.keys(connectedAccounts).length > 0 ? { connectedAccounts } : {}),
  };
}

/**
 * The User-scoped queue's flush (#54): unlike `mutationsToFlush`, there is no
 * Needs Reauth to gate on — that state belongs to a Mail Account, and a
 * Preference edit is never about one.
 */
async function userMutationsToFlush(): Promise<QueuedUserMutation[]> {
  const queued = await listQueuedUserMutations();
  return queued.map((mutation) => ({ id: mutation.id, intent: mutation.intent }));
}

/** The `noteSaves` channel's own flush (#192, ADR-0023): no Needs Reauth to gate on, same reason `userMutationsToFlush` has none — a Note is never about a Mail Account. */
async function noteSavesToFlush(): Promise<NoteSave[]> {
  const queued = await listQueuedNoteSaves();
  return queued.map((save) => toWireNoteSave(save));
}

/**
 * `Needs Reauth` holds the queue rather than failing it (ADR-0011): this is
 * the entire mechanism — such a Mail Account's mutations are simply never
 * placed in the outgoing request, so they are never rejected, never
 * retried, and never touched until the User re-authenticates and a normal
 * sync round picks the account back up as `active`.
 */
async function mutationsToFlush(account: MailAccount): Promise<QueuedMutation[]> {
  if (account.status === "needs_reauth") return [];
  const queued = await listQueuedMutations(account.id);
  return queued.map((mutation) => ({ id: mutation.id, intent: mutation.intent }));
}

/** Same Needs Reauth hold as `mutationsToFlush` (CONTEXT.md): autosave waits rather than fails. */
async function composeSavesToFlush(account: MailAccount): Promise<ComposeSave[]> {
  if (account.status === "needs_reauth") return [];
  const queued = await listQueuedComposeSaves(account.id);
  return Promise.all(queued.map((save) => toWireComposeSave(save)));
}
