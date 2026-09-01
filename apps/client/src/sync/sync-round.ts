import type {
  ComposeSave,
  MailAccount,
  QueuedMutation,
  QueuedUserMutation,
  SyncRequest,
  SyncResponse,
} from "@mail/shared";
import {
  listQueuedComposeSaves,
  resolveComposeSaveOutcomes,
  resolveSendOutcomes,
  toWireComposeSave,
} from "../store/compositions.js";
import { readMailAccounts, reconcileCacheSchema } from "../store/index.js";
import { listQueuedMutations, resolveMutationOutcomes } from "../store/mutation-queue.js";
import {
  applyCompositionDelta,
  applyCorrespondentDelta,
  applyLabelDelta,
  applyMailAccountDelta,
  applyPreferenceDelta,
  applyThreadDelta,
  compositionTokenKey,
  correspondentTokenKey,
  getSyncToken,
  labelTokenKey,
  listCachedMailAccountIds,
  MAIL_ACCOUNT_TOKEN_KEY,
  PREFERENCE_TOKEN_KEY,
  pruneOrphanedMailAccountData,
  threadTokenKey,
} from "../store/server-writes.js";
import {
  listQueuedUserMutations,
  resolveUserMutationOutcomes,
} from "../store/user-mutation-queue.js";
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

  while (pages < MAX_PAGES_PER_ROUND) {
    const request = await buildSyncRequest({
      includeCollections: true,
      includeMutations: pages === 0,
    });
    const askedAbout = new Set(Object.keys(request.mailAccounts ?? {}));
    const response = await post(request);
    pages += 1;

    if (pages === 1) {
      await applyMutationOutcomes(request, response);
      await applyComposeSaveOutcomes(request, response);
      await applyUserMutationOutcomes(request, response);
    }

    let hasMore = false;

    const mailAccountDelta = response.user.MailAccount;
    if (mailAccountDelta) {
      changed = true;
      hasMore ||= mailAccountDelta.hasMore;
      await applyMailAccountDelta(mailAccountDelta, {
        replace: startsReplay(replaysStarted, MAIL_ACCOUNT_TOKEN_KEY, mailAccountDelta.reset),
      });
    }

    const preferenceDelta = response.user.Preference;
    if (preferenceDelta) {
      changed = true;
      hasMore ||= preferenceDelta.hasMore;
      await applyPreferenceDelta(preferenceDelta, {
        replace: startsReplay(replaysStarted, PREFERENCE_TOKEN_KEY, preferenceDelta.reset),
      });
    }

    for (const [mailAccountId, collections] of Object.entries(response.mailAccounts)) {
      const threadDelta = collections.Thread;
      if (threadDelta) {
        changed = true;
        hasMore ||= threadDelta.hasMore;
        await applyThreadDelta(mailAccountId, threadDelta, {
          replace: startsReplay(replaysStarted, threadTokenKey(mailAccountId), threadDelta.reset),
        });
      }

      const labelDelta = collections.Label;
      if (labelDelta) {
        changed = true;
        hasMore ||= labelDelta.hasMore;
        await applyLabelDelta(mailAccountId, labelDelta, {
          replace: startsReplay(replaysStarted, labelTokenKey(mailAccountId), labelDelta.reset),
        });
      }

      const compositionDelta = collections.Composition;
      if (compositionDelta) {
        changed = true;
        hasMore ||= compositionDelta.hasMore;
        await applyCompositionDelta(mailAccountId, compositionDelta, {
          replace: startsReplay(
            replaysStarted,
            compositionTokenKey(mailAccountId),
            compositionDelta.reset,
          ),
        });
      }

      const correspondentDelta = collections.Correspondent;
      if (correspondentDelta) {
        changed = true;
        hasMore ||= correspondentDelta.hasMore;
        await applyCorrespondentDelta(mailAccountId, correspondentDelta, {
          replace: startsReplay(
            replaysStarted,
            correspondentTokenKey(mailAccountId),
            correspondentDelta.reset,
          ),
        });
      }
    }

    // A first-ever boot learns its Mail Accounts from the round it is in the
    // middle of. Going again immediately is what makes the Threads of a
    // freshly added account arrive on the cold-boot sync rather than 30s later.
    const discovered = (await listCachedMailAccountIds()).some((id) => !askedAbout.has(id));
    if (!hasMore && !discovered) break;
  }

  await pruneOrphanedMailAccountData();
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
    (request.user?.mutations?.length ?? 0) === 0
  ) {
    return 0;
  }

  const response = await post(request);
  await applyMutationOutcomes(request, response);
  await applyComposeSaveOutcomes(request, response);
  await applyUserMutationOutcomes(request, response);
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
    await resolveSendOutcomes(
      outcomes.flatMap((outcome) => {
        const intent = byId.get(outcome.id);
        return intent ? [{ intent, status: outcome.status, reason: outcome.reason }] : [];
      }),
    );
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
      entry.Thread = await getSyncToken(threadTokenKey(account.id));
      entry.Label = await getSyncToken(labelTokenKey(account.id));
      entry.Composition = await getSyncToken(compositionTokenKey(account.id));
      entry.Correspondent = await getSyncToken(correspondentTokenKey(account.id));
    }
    if (includeMutations) {
      const mutations = await mutationsToFlush(account);
      if (mutations.length > 0) entry.mutations = mutations;
      const composeSaves = await composeSavesToFlush(account);
      if (composeSaves.length > 0) entry.composeSaves = composeSaves;
    }
    if (
      entry.Thread !== undefined ||
      entry.Label !== undefined ||
      entry.Composition !== undefined ||
      entry.Correspondent !== undefined ||
      entry.mutations !== undefined ||
      entry.composeSaves !== undefined
    ) {
      mailAccounts[account.id] = entry;
    }
  }

  const user: NonNullable<SyncRequest["user"]> = {};
  if (includeCollections) {
    user.MailAccount = await getSyncToken(MAIL_ACCOUNT_TOKEN_KEY);
    user.Preference = await getSyncToken(PREFERENCE_TOKEN_KEY);
  }
  if (includeMutations) {
    const userMutations = await userMutationsToFlush();
    if (userMutations.length > 0) user.mutations = userMutations;
  }

  return {
    ...(Object.keys(user).length > 0 ? { user } : {}),
    mailAccounts,
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
