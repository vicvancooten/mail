import "fake-indexeddb/auto";

/**
 * jsdom ships no IndexedDB, so the Local Cache's suites run against
 * `fake-indexeddb`. Imported from `vite.config.ts`'s `setupFiles` so it is
 * installed before any module-level Dexie handle is constructed.
 */
