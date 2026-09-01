import type { MailAccount } from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import {
  type CachedThread,
  DEFAULT_VIEW,
  type LocalCache,
  listWindowKey,
  type PendingMutation,
  type ViewKey,
} from "./db.js";
import { localCache } from "./local-cache.js";
import { threadsInWindow } from "./server-writes.js";

/**
 * The Client's only read path (ADR-0010). Components subscribe to these
 * reactive reads and never see Dexie, a state token, or a queue row. Reads
 * are what the UI renders from — the Local Cache is the source of truth, not
 * a network response, so nothing here ever awaits a fetch.
 *
 * `undefined` from a hook means "the first read hasn't resolved yet", which
 * is a frame or two, not a loading state to render a spinner for.
 *
 * **`base ⊕ pending` is composed here** (#39): `readThreadWindow` overlays
 * every pending Optimistic Action onto the base row it targets before a
 * component ever sees it, so there is no path from "components read
 * through here" to "a component renders an un-overlaid base row". Dexie's
 * `liveQuery` tracks the `pendingMutations` reads this performs the same
 * way it tracks `threads` — enqueuing or resolving a mutation re-renders
 * exactly like a base-row change would.
 */

/** ADR-0010's cold start: paint the top page of the last-active list, ~50 rows, and nothing else. */
export const THREAD_PAGE_SIZE = 50;

export function useMailAccounts(): MailAccount[] | undefined {
  return useLiveQuery(() => readMailAccounts(), []);
}

/** Ordered by `createdAt` so the account switcher and "first account" are stable across reloads. */
export function readMailAccounts(): Promise<MailAccount[]> {
  return localCache().mailAccounts.orderBy("createdAt").toArray();
}

export interface ThreadWindowPage {
  /** Newest first. */
  threads: CachedThread[];
  /**
   * False when the window has been truncated at the bottom: there is older
   * mail the Client does not hold, and the list must end with an explicit
   * affordance rather than pretending it reached the beginning.
   */
  complete: boolean;
}

export interface ThreadWindowOptions {
  view?: ViewKey;
  limit?: number;
}

export function useThreadWindow(
  mailAccountId: string | null,
  { view = DEFAULT_VIEW, limit = THREAD_PAGE_SIZE }: ThreadWindowOptions = {},
): ThreadWindowPage | undefined {
  return useLiveQuery(
    () =>
      mailAccountId === null
        ? Promise.resolve({ threads: [], complete: true })
        : readThreadWindow(mailAccountId, { view, limit }),
    [mailAccountId, view, limit],
  );
}

/**
 * The top `limit` Threads of one (Mail Account, view), newest first. Served
 * off the `[mailAccountId+sortKey]` index, so the order is the index's and
 * not an incidental property of the scan.
 */
export async function readThreadWindow(
  mailAccountId: string,
  { view = DEFAULT_VIEW, limit = THREAD_PAGE_SIZE }: ThreadWindowOptions = {},
): Promise<ThreadWindowPage> {
  const db = localCache();
  const window = await db.listWindows.get(listWindowKey(mailAccountId, view));
  if (!window) return { threads: [], complete: true };

  const threads = await threadsInWindow(db, window).reverse().limit(limit).toArray();
  return { threads: await overlayPendingMutations(db, threads), complete: window.complete };
}

/**
 * `base ⊕ pending`: for every Thread on the page, applies the queued
 * Optimistic Actions that name it, oldest first (`id` — a ULID — sorts by
 * creation time, which is `order what you assert on` rather than trusting
 * an unordered `anyOf` scan). Both intents are absolute sets, so applying
 * more than one is just "last one wins", never a fold that needs the base
 * value to seed it.
 */
async function overlayPendingMutations(
  db: LocalCache,
  threads: CachedThread[],
): Promise<CachedThread[]> {
  if (threads.length === 0) return threads;

  const threadIds = threads.map((thread) => thread.id);
  const relevant = await db.pendingMutations
    .where("referencedThreadIds")
    .anyOf(threadIds)
    .toArray();
  if (relevant.length === 0) return threads;

  relevant.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const byThreadId = new Map<string, PendingMutation[]>();
  for (const mutation of relevant) {
    for (const threadId of mutation.referencedThreadIds) {
      const bucket = byThreadId.get(threadId);
      if (bucket) bucket.push(mutation);
      else byThreadId.set(threadId, [mutation]);
    }
  }

  return threads.map((thread) => {
    const mutations = byThreadId.get(thread.id);
    return mutations ? applyOverlay(thread, mutations) : thread;
  });
}

function applyOverlay(thread: CachedThread, mutations: PendingMutation[]): CachedThread {
  let overlaid = thread;
  for (const mutation of mutations) {
    switch (mutation.intent.type) {
      case "setStarred":
        overlaid = { ...overlaid, starred: mutation.intent.starred };
        break;
      case "setRead":
        // Mirrors `sync/mutations.ts`'s backend semantics exactly: the
        // intent sets `\Seen` on every Message in the Thread, so the
        // overlay's `unreadCount` is 0 (read) or every Message (unread),
        // never an in-between guess.
        overlaid = { ...overlaid, unreadCount: mutation.intent.read ? 0 : overlaid.messageCount };
        break;
    }
  }
  return overlaid;
}
