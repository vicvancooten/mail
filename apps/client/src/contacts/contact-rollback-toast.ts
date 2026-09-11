import type { ContactRollback } from "@mail/shared";

/**
 * Write-back's own "upstream wins" narration on the Client (#216) —
 * `store/mutation-queue.ts#subscribeMutationRejections`'s own shape, sourced
 * from the `ContactRollback` collection's own deltas instead of a rejected
 * Optimistic Action: unlike a Mail mutation, a Google write-back's own
 * failure is discovered well after the edit that triggered it already
 * "succeeded" from this Client's own point of view (`store/server-writes.ts#applyContactRollbackDelta`'s
 * own doc comment on why this can't ride that queue's rejection channel).
 */

const listeners = new Set<(rollback: ContactRollback) => void>();

/** `ContactRollbackToast.tsx`'s only subscriber — one at a time in practice (mounted once in `RootLayout`), a `Set` regardless for the same "more than one listener is never wrong" posture `subscribeMutationRejections` takes. */
export function subscribeContactRollbacks(
  listener: (rollback: ContactRollback) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `applyContactRollbackDelta`'s only caller — never called for a `reset: true` replay's own backlog (that function's own doc comment: a fresh install or a schema-version wipe must not toast for every rollback that ever happened). */
export function notifyContactRollback(rollback: ContactRollback): void {
  for (const listener of listeners) listener(rollback);
}

/** The toast's own copy, one line per `ContactRollbackReason` (`@mail/shared#contactRollbackReasonSchema`). */
export function contactRollbackMessage(rollback: ContactRollback): string {
  const name = rollback.contactName.trim().length > 0 ? rollback.contactName : "This contact";
  switch (rollback.reason) {
    case "google_conflict":
      return `Couldn't sync "${name}" to Google — it changed there first. Reverted.`;
    case "google_not_found":
      return `Couldn't sync "${name}" to Google — it was deleted there. Reverted.`;
    case "google_rejected":
      return `Couldn't sync "${name}" to Google. Reverted.`;
    case "carddav_conflict":
      return `Couldn't sync "${name}" — it changed on the server first. Reverted.`;
    case "carddav_not_found":
      return `Couldn't sync "${name}" — it was deleted on the server. Reverted.`;
    case "carddav_rejected":
      return `Couldn't sync "${name}" to the server. Reverted.`;
  }
}
