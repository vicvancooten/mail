/**
 * The trigger for the one-time inline notification offer (#53, ADR-0015):
 * "permission asked at most twice ... plus one inline offer after the first
 * successful triage session". `useTriage.ts` calls `notifyTriageSucceeded`
 * from every one of its actions; this fires at most once per page load,
 * leaving the actual "has this device already seen the offer, ever"
 * decision to whichever banner subscribes (`readNotificationOfferShown`,
 * `mail/device-preferences.ts`) — this module only knows about *this*
 * session's first success, never about persisted state, so it stays free
 * of a dependency on `mail/`'s own storage module.
 */

let firedThisSession = false;
const listeners = new Set<() => void>();

export function subscribeNotificationOfferTrigger(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyTriageSucceeded(): void {
  if (firedThisSession) return;
  firedThisSession = true;
  for (const listener of listeners) listener();
}

/** Test seam: the module-level flag outlives one test's render, unlike a real page load. */
export function resetNotificationOfferTrigger(): void {
  firedThisSession = false;
}
