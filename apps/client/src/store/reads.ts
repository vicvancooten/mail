import type { MailAccount } from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { type CachedThread, DEFAULT_VIEW, listWindowKey, type ViewKey } from "./db.js";
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
 * **#39 composes `base ⊕ pending` here**: the overlay is applied inside
 * these reads so a component cannot accidentally render un-overlaid base
 * rows. Today there are no pending actions to overlay, so the reads are the
 * base rows alone.
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
  return { threads, complete: window.complete };
}
