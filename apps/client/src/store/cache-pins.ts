import type { Thread } from "@mail/shared";
import { localCache } from "./local-cache.js";
import { threadSortKey } from "./thread-sort-key.js";

/**
 * "Any Thread the User opens is pinned into the entity cache regardless of
 * age" (ADR-0009). A cache pin is a local retention fact, not mail state —
 * deliberately not the user-facing **Pin** from CONTEXT.md, and deliberately
 * not a column on the Thread row, which `sync/` alone owns.
 *
 * A pin keeps the entity; it does not put the Thread back into a list
 * window it has aged out of.
 */

export async function pinThreadIntoCache(threadId: string): Promise<void> {
  const db = localCache();
  const thread = await db.threads.get(threadId);
  // Nothing to retain: a Thread the cache never held can only be pinned once
  // something materializes it (search results do, per docs/search-ux-spec.md).
  if (!thread) return;
  await db.cachePins.put({
    threadId,
    mailAccountId: thread.mailAccountId,
    pinnedAt: new Date().toISOString(),
  });
}

export async function unpinThreadFromCache(threadId: string): Promise<void> {
  await localCache().cachePins.delete(threadId);
}

/**
 * "Search results do" (this file's own comment above): a search result can
 * name a Thread outside every held window (search reaches the whole Search
 * Index; the cache holds a bounded working set, ADR-0009), so acting on it
 * — the standard triage set, per `docs/search-ux-spec.md` §Acting on a
 * result — needs a base row first, for ADR-0010's `base ⊕ pending` overlay
 * to render and roll back against. Writes the row **and** pins it in one
 * call: a materialized-but-unpinned row would just get evicted again on the
 * next trim, defeating the point.
 */
export async function materializeSearchResultThread(thread: Thread): Promise<void> {
  const db = localCache();
  await db.threads.put({ ...thread, sortKey: threadSortKey(thread) });
  await pinThreadIntoCache(thread.id);
}
