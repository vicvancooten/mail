import {
  CACHE_SCHEMA_VERSION,
  type CacheSchemaOutcome,
  DEFAULT_CACHE_NAME,
  ensureCacheSchema,
  LocalCache,
} from "./db.js";

/**
 * Owns the one open Local Cache handle. `ensureLocalCacheOpen()` is the boot
 * entry point — it opens the handle, reconciles the schema, requests storage
 * persistence, and hands back what happened; `localCache()` is the
 * synchronous handle every read and write in `store/` closes over.
 */

let cache: LocalCache | null = null;
let opening: Promise<CacheSchemaOutcome> | null = null;

export interface OpenLocalCacheOptions {
  name?: string;
  schemaVersion?: number;
}

/**
 * Opens a *replacement* cache under an explicit name or schema version. Boot
 * does not use this — `ensureLocalCacheOpen` does — because swapping the
 * handle would strand every `liveQuery` already subscribed to the old one.
 * This is the seam for a test that wants an isolated database per case.
 */
export function openLocalCache(options: OpenLocalCacheOptions = {}): Promise<CacheSchemaOutcome> {
  if (cache) cache.close();
  cache = new LocalCache(
    options.name ?? DEFAULT_CACHE_NAME,
    options.schemaVersion ?? CACHE_SCHEMA_VERSION,
  );
  opening = openHandle(cache);
  return opening;
}

/**
 * The boot path: opens the one handle and reconciles its schema, once per
 * page load. A second caller — a remounted provider, a StrictMode
 * double-mount — joins the same open rather than starting another.
 */
export function ensureLocalCacheOpen(): Promise<CacheSchemaOutcome> {
  opening ??= openHandle(localCache());
  return opening;
}

async function openHandle(db: LocalCache): Promise<CacheSchemaOutcome> {
  // A cache written by a *newer* build (a rollback mid-dogfood) doesn't fail
  // here: Dexie answers IndexedDB's `VersionError` by reopening at whatever
  // version is on disk. It is `cacheMeta`'s recorded version, not Dexie's,
  // that catches the mismatch below — which is why a downgrade wipes exactly
  // like a bump does, queue protection included.
  await db.open();
  requestStoragePersistence();
  return ensureCacheSchema(db);
}

/**
 * Re-runs the schema reconciliation against the open handle. `sync/` calls
 * this before every round, so a wipe that was deferred over a non-empty
 * Optimistic Action queue happens the moment that queue drains.
 */
export function reconcileCacheSchema(): Promise<CacheSchemaOutcome> {
  return ensureCacheSchema(localCache());
}

/** The current handle, lazily constructed so a read before `openLocalCache()` still works. */
export function localCache(): LocalCache {
  if (!cache) cache = new LocalCache();
  return cache;
}

/**
 * Cheap insurance against the browser evicting the cache (ADR-0009), asked
 * for once per open. Best-effort by design: a refusal costs nothing but a
 * rebuild, so nothing here waits on it or reports it.
 */
function requestStoragePersistence(): void {
  void globalThis.navigator?.storage?.persist?.().catch(() => {});
}
