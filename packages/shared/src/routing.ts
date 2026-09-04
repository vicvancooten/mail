/**
 * The app-shell-only boundary from `poc-spec.md` §Wire API & client data
 * layer / ADR-0009-client, made a pure predicate: every path that is a real
 * API endpoint rather than a client-side route.
 *
 * Shared between the Client's service worker (`apps/client/src/pwa/shell-routing.ts`,
 * which must never intercept, cache, or answer these from the cache — the
 * browser's ordinary networking owns them end to end) and the Sync
 * Backend's SPA fallback (`apps/sync-backend/src/app.ts`'s `setNotFoundHandler`,
 * which must never serve the app shell in place of a genuine 404 for one of
 * these) — #92. One list, so the two layers can't drift apart.
 */
export function isApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/sync") || pathname.startsWith("/auth") || pathname.startsWith("/healthz")
  );
}
