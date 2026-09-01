import { isApiPath, manifestFingerprint } from "./pwa/shell-routing.js";

// `lib.webworker.d.ts` (this file's own `tsconfig.sw.json`) types `self` as
// the generic `WorkerGlobalScope` shared across worker kinds; narrow it to
// the service-worker-specific shape (`clients`, `skipWaiting`, …) here.
declare const self: ServiceWorkerGlobalScope;

/**
 * The app-shell-only service worker (#44, `poc-spec.md` §Wire API & client
 * data layer, ADR-0009-client): "the service worker caches the app shell
 * only — no API responses, ever." Offline mail data is the Local Cache's
 * job (IndexedDB via Dexie); an HTTP cache of `/sync`/`/auth` responses
 * would be a second, un-reconcilable source of truth, so this worker never
 * touches `fetch` for anything but the built client bundle and never even
 * registers a route for API paths — there is no cache-vs-network decision
 * to get wrong for them because they're never intercepted at all.
 *
 * Precache list comes from `vite-plugin-pwa`'s `injectManifest` strategy:
 * `self.__WB_MANIFEST` is replaced at build time with every hashed built
 * asset's URL + revision, so a deploy's shell is exactly the files that
 * shipped with it — no separate glob/version list to keep in sync by hand.
 * `injectManifest` (rather than `generateSW`) is deliberate: it hands this
 * file full control instead of Workbox's routing DSL, which is what lets
 * the "no API caching, ever" rule live here as "there is no route for it"
 * rather than "there is a route someone must remember to exclude".
 */

// Populated by vite-plugin-pwa at build time; empty in `vite dev` (no build
// has run), which is fine — dev never installs this worker (see main.tsx).
const PRECACHE_MANIFEST = self.__WB_MANIFEST ?? [];
// A cache name derived from the precache list itself — see
// `manifestFingerprint`'s doc comment for why, which is what lets
// `activate` below drop every previous version's cache without tracking a
// build id by hand.
const SHELL_CACHE = `mail-shell-${manifestFingerprint(PRECACHE_MANIFEST)}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const urls = PRECACHE_MANIFEST.map((entry) => entry.url);
      await cache.addAll(urls);
      // Deliberately no `self.skipWaiting()` here: ADR-0009-client — "Client
      // updates prompt, never auto-reload... a new version applies on the
      // next cold start." A newly installed worker sits in `waiting` until
      // either the reload-prompt banner posts `SKIP_WAITING` (main.tsx) or
      // every tab on the old version closes, which is the browser's own
      // "next cold start" behavior with no extra code needed for it.
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("mail-shell-") && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

const PRECACHED_URLS = new Set(
  PRECACHE_MANIFEST.map((entry) => new URL(entry.url, self.location.origin).pathname),
);

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept mutations — nothing to cache-first here anyway
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // shell only: no cross-origin caching

  // The one hard boundary: API paths are never handled by this listener at
  // all, so the browser's normal networking owns them end to end — no
  // cache read, no cache write, not even a pass-through `fetch()` here.
  if (isApiPath(url.pathname)) return;

  // A precached shell asset: cache-first, since its URL is either
  // content-hashed (the JS/CSS bundle) or, for `index.html`, pinned to this
  // build by `SHELL_CACHE`'s own fingerprint — either way it can never go
  // stale under this specific cache name.
  if (PRECACHED_URLS.has(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
    return;
  }

  // SPA navigation fallback: an offline deep link (e.g. reopening on
  // `/search?q=`) still gets the shell instead of the browser's own
  // offline error page. Online, this always goes to the network first so a
  // navigation never serves a stale shell while online.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(SHELL_CACHE);
        const shell = await cache.match("/index.html");
        return shell ?? Response.error();
      }),
    );
  }
});
