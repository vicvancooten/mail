/**
 * "Open in new window" (#292): opens the standalone Reader route
 * (`router/routes.tsx#mailReaderRoute`, `/mail/reader/$threadId`) in a real
 * browser window rather than navigating this one away from wherever the
 * User already is — the whole point of the action (CONTEXT.md's own phrase,
 * "keep a Thread open while working elsewhere"). A plain path, not a
 * `RouterContext`-aware `navigate()`: the target is a fresh window with its
 * own history, not a place this app's own router is about to go, the same
 * reason `reading/MessageBody.tsx`'s `mailto:`/external-link opener below
 * already reaches for `window.open` instead. `noopener,noreferrer` keeps the
 * new window from holding a live `window.opener` back to this one.
 */
export function openReaderWindow(threadId: string): void {
  window.open(`/mail/reader/${threadId}`, "_blank", "noopener,noreferrer");
}
