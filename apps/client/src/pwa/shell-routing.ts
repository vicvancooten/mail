/**
 * The pure decisions `src/sw.ts` makes about a request, pulled out into a
 * plain module so they're unit-testable under `pnpm test` (jsdom has no
 * Service Worker globals — `caches`, `self.clients`, … — to run `sw.ts`
 * itself against, but none of that is needed to test *which* requests it
 * would touch). `sw.ts` imports these directly; nothing here knows what a
 * `Request` or a `Cache` is.
 */

export interface ManifestEntry {
  url: string;
  revision: string | null;
}

/**
 * The app-shell-only boundary from `poc-spec.md` §Wire API & client data
 * layer / ADR-0009-client, made a pure predicate: every path the service
 * worker must never intercept, cache, or answer from the cache — the
 * browser's ordinary networking owns these end to end.
 */
export function isApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/sync") || pathname.startsWith("/auth") || pathname.startsWith("/healthz")
  );
}

/**
 * A cache-name suffix derived from the precache list's own contents, order
 * -independent (sorted first) so two builds producing the same asset set in
 * a different manifest order still land on one cache name. Changes exactly
 * when the shell's contents do, which is what lets `sw.ts`'s `activate`
 * drop every previous version's cache without tracking a build id by hand.
 */
export function manifestFingerprint(entries: ManifestEntry[]): string {
  if (entries.length === 0) return "empty"; // `vite dev`'s never-installed worker; never a real build's cache name
  const sorted = [...entries].sort((a, b) => a.url.localeCompare(b.url));
  let hash = 0;
  for (const entry of sorted) {
    const text = entry.url + (entry.revision ?? "");
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
