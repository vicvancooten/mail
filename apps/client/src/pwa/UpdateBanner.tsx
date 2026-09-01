import { useSyncExternalStore } from "react";
import { applyPendingUpdate, hasPendingUpdate, subscribePendingUpdate } from "./update.js";

/**
 * The "unobtrusive reload prompt" the ticket asks for (#44,
 * ADR-0009-client): a new bundle is ready, but nothing reloads until the
 * User says so — reloading mid-triage would swap the running bundle out
 * from under an in-progress action. Renders nothing at all until
 * `update.ts` has a waiting worker, and nothing more than one line and a
 * button once it does — this is deliberately not a modal, since the whole
 * point is that ignoring it costs nothing (the update still applies on the
 * next natural cold start).
 */
export function UpdateBanner() {
  const pending = useSyncExternalStore(subscribePendingUpdate, hasPendingUpdate, () => false);

  if (!pending) return null;

  return (
    <div className="pwa-update-banner" role="status">
      <span>A new version is ready.</span>
      <button type="button" onClick={() => applyPendingUpdate()}>
        Reload
      </button>
    </div>
  );
}
