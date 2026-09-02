// Ambient typing for the one build-time global `vite-plugin-pwa`'s
// `injectManifest` strategy injects into `src/sw.ts`: the precache list of
// this build's hashed app-shell assets. See `sw.ts`'s docstring.
interface ServiceWorkerGlobalScope {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
}

// Background Sync (#53, ADR-0015) is Chrome/Android-only and, per
// `docs/research/0006` §6, not even a stated-position W3C proposal — TypeScript's
// own `lib.webworker.d.ts` ships no types for it at all. `sw.ts` feature-detects
// `"sync" in registration` before ever touching this, exactly the way it treats
// every other browser-support gap in this file.
interface SyncManager {
  register(tag: string): Promise<void>;
  getTags(): Promise<string[]>;
}
interface ServiceWorkerRegistration {
  readonly sync: SyncManager;
}
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
  readonly lastChance: boolean;
}
interface ServiceWorkerGlobalScopeEventMap {
  sync: SyncEvent;
}

// `NotificationOptions.actions` (Chrome/Android's notification action
// buttons, ADR-0015/`docs/research/0006` §3): shipped in Chrome, absent from
// TypeScript's own `lib.webworker.d.ts` just as it's absent from WebKit's
// `NotificationOptions.idl` — a WebIDL dictionary silently drops an unknown
// member rather than erroring, which is exactly why `showNotification` can
// pass this unconditionally everywhere and simply get no buttons where the
// platform doesn't support them.
interface NotificationAction {
  action: string;
  title: string;
}
interface NotificationOptions {
  actions?: NotificationAction[];
}
