import type { MutationIntent, MutationOutcome, QueuedMutation } from "@mail/shared";
import { normalizeLabelName } from "@mail/shared";
import type { PendingMutation } from "./db.js";
import { localCache } from "./local-cache.js";
import { generateUlid } from "./ulid.js";

/**
 * The Optimistic Action queue's only writers (ADR-0010's two-writer rule,
 * #39). `enqueueMutation` is what a component calls — the wrong move
 * ("write the base row directly") isn't reachable from here, only "queue an
 * intent" is. `listQueuedMutations`/`resolveMutationOutcomes` are `sync/`'s
 * side of the same table: the flush reads what to send, in FIFO order, and
 * removes a row once the Sync Backend has answered for it — applied *and*
 * rejected both dequeue, because rollback is a row deletion (ADR-0010) and
 * the re-render is automatic.
 */

/** Which Thread(s) a `MutationIntent` is about — the eviction-exempt set (ADR-0009) and the overlay's match key (`reads.ts`). */
function referencedThreadIds(intent: MutationIntent): string[] {
  switch (intent.type) {
    case "setStarred":
    case "setRead":
    case "archive":
    case "trash":
    case "setPinned":
    case "applyLabel":
    case "removeLabel":
      return [intent.threadId];
  }
}

/**
 * What "the exact inverse, still queued" means for one intent kind
 * (ADR-0010: no coalescing beyond this trivial case). `archive`/`trash`
 * (#42) have no inverse intent yet — there is no `unarchive` — so their key
 * never matches anything else's; `value: true` is a fixed placeholder, not
 * a real toggle. `applyLabel`/`removeLabel` (#43) share one `"label"`
 * bucket keyed on `threadId:name` so applying then removing (or vice versa)
 * the same name on the same Thread while both are still queued coalesces
 * away exactly like star does, rather than shipping a self-cancelling pair.
 */
function coalesceKey(intent: MutationIntent): { type: string; targetId: string; value: boolean } {
  switch (intent.type) {
    case "setStarred":
      return { type: "setStarred", targetId: intent.threadId, value: intent.starred };
    case "setRead":
      return { type: "setRead", targetId: intent.threadId, value: intent.read };
    case "archive":
      return { type: "archive", targetId: intent.threadId, value: true };
    case "trash":
      return { type: "trash", targetId: intent.threadId, value: true };
    case "setPinned":
      return { type: "setPinned", targetId: intent.threadId, value: intent.pinned };
    case "applyLabel":
      return {
        type: "label",
        targetId: `${intent.threadId}:${normalizeLabelName(intent.name)}`,
        value: true,
      };
    case "removeLabel":
      return {
        type: "label",
        targetId: `${intent.threadId}:${normalizeLabelName(intent.name)}`,
        value: false,
      };
  }
}

/**
 * Queues one Optimistic Action for a Mail Account. A queued action exactly
 * undone while still queued (star → unstar) drops both rows instead of
 * queuing a second one — that is already the Undo button's mechanism, and
 * ADR-0010 asks for nothing cleverer than this one trivial case.
 *
 * Returns the new mutation's id, or `null` when it coalesced away instead
 * of being queued.
 */
export async function enqueueMutation(
  intent: MutationIntent,
  mailAccountId: string,
): Promise<string | null> {
  const db = localCache();
  const key = coalesceKey(intent);

  return db.transaction("rw", db.pendingMutations, async () => {
    const candidates = await db.pendingMutations
      .where("mailAccountId")
      .equals(mailAccountId)
      .toArray();
    const inverse = candidates.find((candidate) => {
      const candidateKey = coalesceKey(candidate.intent);
      return (
        candidateKey.type === key.type &&
        candidateKey.targetId === key.targetId &&
        candidateKey.value !== key.value
      );
    });
    if (inverse) {
      await db.pendingMutations.delete(inverse.id);
      return null;
    }

    const id = generateUlid();
    await db.pendingMutations.put({
      id,
      mailAccountId,
      createdAt: new Date().toISOString(),
      referencedThreadIds: referencedThreadIds(intent),
      intent,
    });
    return id;
  });
}

/** This Mail Account's queue, oldest first (ADR-0010: strict FIFO per Mail Account). */
export async function listQueuedMutations(mailAccountId: string): Promise<PendingMutation[]> {
  return localCache().pendingMutations.where("mailAccountId").equals(mailAccountId).sortBy("id");
}

/**
 * Removes the mutations a flush received outcomes for — applied and
 * rejected alike. A rejected outcome is reported to `subscribeMutationRejections`
 * listeners first, so a future toast has something to name before the row
 * (and the intent it carried) is gone. `queued` is the wire request's own
 * `mutations` array (id + intent), not a fresh Dexie read — a row already
 * dequeued by a coalescing `enqueueMutation` call mid-flight has nothing
 * left to look up anyway.
 */
export async function resolveMutationOutcomes(
  mailAccountId: string,
  queued: QueuedMutation[],
  outcomes: MutationOutcome[],
): Promise<void> {
  const byId = new Map(queued.map((mutation) => [mutation.id, mutation]));
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      const mutation = byId.get(outcome.id);
      if (mutation)
        notifyRejection({ mailAccountId, intent: mutation.intent, reason: outcome.reason });
    }
    await localCache().pendingMutations.delete(outcome.id);
  }
}

export interface MutationRejection {
  mailAccountId: string;
  intent: MutationIntent;
  reason: string | undefined;
}

const rejectionListeners = new Set<(rejection: MutationRejection) => void>();

/** Seam for a future toast ("rollback, plus a toast naming the action, with a retry" — ADR-0011). Nothing subscribes yet. */
export function subscribeMutationRejections(
  listener: (rejection: MutationRejection) => void,
): () => void {
  rejectionListeners.add(listener);
  return () => rejectionListeners.delete(listener);
}

function notifyRejection(rejection: MutationRejection): void {
  for (const listener of rejectionListeners) listener(rejection);
}
