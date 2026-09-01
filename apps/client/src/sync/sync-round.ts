import type { SyncRequest } from "@mail/shared";
import { reconcileCacheSchema } from "../store/index.js";
import {
  applyMailAccountDelta,
  applyThreadDelta,
  getSyncToken,
  listCachedMailAccountIds,
  MAIL_ACCOUNT_TOKEN_KEY,
  pruneOrphanedMailAccountData,
  threadTokenKey,
} from "../store/server-writes.js";
import { type PostSync, postSync } from "./sync-api.js";

/**
 * One round of `POST /sync`: request the collections this Client holds,
 * apply what comes back, and keep going while the Sync Backend says there is
 * more. `sync/` is the only holder of state tokens and the only thing that
 * writes base rows (ADR-0010) — it does the latter through
 * `store/server-writes.ts`, which is the module that owns Dexie.
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
   * drain (ADR-0009). Nothing was fetched: the cache keeps serving its old
   * data, and the next round re-checks.
   */
  deferred: boolean;
  pages: number;
  /** True when at least one collection carried a change. */
  changed: boolean;
}

export async function runSyncRound(post: PostSync = postSync): Promise<SyncRoundResult> {
  const schema = await reconcileCacheSchema();
  if (schema.status === "deferred") return { deferred: true, pages: 0, changed: false };

  // A `reset: true` replay spans every page until `hasMore` goes false, and
  // only its *first* page discards what the Client had. Clearing on each
  // page would leave the cache holding the last page alone.
  const replaysStarted = new Set<string>();
  let pages = 0;
  let changed = false;

  while (pages < MAX_PAGES_PER_ROUND) {
    const request = await buildSyncRequest();
    const askedAbout = new Set(Object.keys(request.mailAccounts ?? {}));
    const response = await post(request);
    pages += 1;

    let hasMore = false;

    const mailAccountDelta = response.user.MailAccount;
    if (mailAccountDelta) {
      changed = true;
      hasMore ||= mailAccountDelta.hasMore;
      await applyMailAccountDelta(mailAccountDelta, {
        replace: startsReplay(replaysStarted, MAIL_ACCOUNT_TOKEN_KEY, mailAccountDelta.reset),
      });
    }

    for (const [mailAccountId, collections] of Object.entries(response.mailAccounts)) {
      const threadDelta = collections.Thread;
      if (!threadDelta) continue;
      changed = true;
      hasMore ||= threadDelta.hasMore;
      await applyThreadDelta(mailAccountId, threadDelta, {
        replace: startsReplay(replaysStarted, threadTokenKey(mailAccountId), threadDelta.reset),
      });
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

function startsReplay(started: Set<string>, key: string, reset: true | undefined): boolean {
  if (reset !== true) return false;
  const first = !started.has(key);
  started.add(key);
  return first;
}

/**
 * `null` for a collection the Client holds nothing of yet — a bootstrap, not
 * the same thing as a stale token, which the server answers with `reset`.
 */
async function buildSyncRequest(): Promise<SyncRequest> {
  const mailAccountIds = await listCachedMailAccountIds();
  const mailAccounts: NonNullable<SyncRequest["mailAccounts"]> = {};
  for (const id of mailAccountIds) {
    mailAccounts[id] = { Thread: await getSyncToken(threadTokenKey(id)) };
  }
  return {
    user: { MailAccount: await getSyncToken(MAIL_ACCOUNT_TOKEN_KEY) },
    mailAccounts,
  };
}
