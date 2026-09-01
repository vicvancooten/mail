/**
 * The `store` module: the only code in the Client that imports Dexie
 * (ADR-0010). Its surface is deliberately three separate things, and which
 * one you may call depends on what you are:
 *
 * - **Components** read through the hooks in `reads.ts` and pin opened
 *   Threads through `cache-pins.ts`. That is all they may touch.
 * - **`sync/`** — and nothing else — writes base rows and reads state tokens
 *   through `server-writes.ts`.
 * - **Boot** opens the cache through `local-cache.ts`.
 *
 * The point of the seam is not testability: it is that the wrong move
 * ("just write to the table") isn't reachable from a component.
 */

export { pinThreadIntoCache, unpinThreadFromCache } from "./cache-pins.js";
export {
  CACHE_SCHEMA_VERSION,
  type CachedThread,
  type CacheSchemaOutcome,
  DEFAULT_VIEW,
  type ListWindow,
  type ViewKey,
} from "./db.js";
export {
  ensureLocalCacheOpen,
  type OpenLocalCacheOptions,
  openLocalCache,
  reconcileCacheSchema,
} from "./local-cache.js";
export {
  readMailAccounts,
  readThreadWindow,
  THREAD_PAGE_SIZE,
  type ThreadWindowPage,
  useMailAccounts,
  useThreadWindow,
} from "./reads.js";
