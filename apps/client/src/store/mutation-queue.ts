import type { MutationIntent, MutationOutcome, QueuedMutation } from "@mail/shared";
import { normalizeLabelName } from "@mail/shared";
import { requestSyncNow } from "../sync/sync-loop.js";
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
    // The Composition intents (#46) and the Mail-Account-scoped Preference
    // intents (#54) name no Thread. Empty is exactly right for both readers:
    // nothing to exempt from Thread eviction, and nothing for the Thread
    // overlay to match against.
    case "sendComposition":
    case "cancelSend":
    case "setSignature":
    case "setNotificationsEnabled":
      return [];
    // The Gatekeeper decisions (#55) name a *sender*, not a Thread — one
    // decision per stranger, however many Threads they are holding. The
    // Threads they release or trash are the Sync Backend's to work out and
    // report back through the ordinary Thread delta, so there is nothing
    // here for the Thread overlay to predict and nothing to exempt from
    // eviction. The Screener's own optimistic feel comes from the row
    // leaving the Screener list, not from a Thread-level overlay.
    case "approveSender":
    case "denySender":
    case "blockSender":
    case "unblockSender":
      return [];
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
    // Send and Undo Send (#46) are a genuine inverse pair, and the *only*
    // one where coalescing is more than an optimization: pressing Undo while
    // the send is still sitting in this queue means the Sync Backend never
    // hears about the send at all, so there is no Pending Send to race and
    // no way for the cancel to arrive too late. Offline, this is the whole
    // of Undo Send.
    case "sendComposition":
      return { type: "send", targetId: intent.compositionId, value: true };
    case "cancelSend":
      return { type: "send", targetId: intent.compositionId, value: false };
    // `setNotificationsEnabled` (#54) is a genuine boolean toggle, so it
    // coalesces the same way `setPinned` does — a Mail Account's own queue is
    // already what `enqueueMutation` scopes candidates to, so "notifications"
    // alone is a unique enough bucket. `setSignature` has no natural inverse
    // (there is no "un-set to this specific string"), so its `value` is a
    // fixed constant that never matches another entry's — two queued edits
    // both ride the queue rather than coalescing, and FIFO order still lands
    // on whichever the User actually typed last.
    case "setNotificationsEnabled":
      return { type: "setNotificationsEnabled", targetId: "notifications", value: intent.enabled };
    case "setSignature":
      return { type: "setSignature", targetId: "signature", value: true };
    // Each Gatekeeper decision (#55) is keyed to its sender, and Approve vs.
    // Block/Deny are not inverses of one another — Deny trashes mail, Approve
    // releases it — so nothing here coalesces away a decision the User
    // actually made. `approveSender` and `unblockSender` are the two that
    // read as "yes", which is what `value` distinguishes; a second decision
    // on the same sender while the first is still queued therefore just
    // queues behind it, and FIFO lands on whichever they chose last.
    case "approveSender":
    case "denySender":
    case "blockSender":
    case "unblockSender":
      return {
        type: `gatekeeper:${intent.type}`,
        targetId: `${intent.sender.scope}:${intent.sender.value.trim().toLowerCase()}`,
        value: intent.type === "approveSender" || intent.type === "unblockSender",
      };
  }
}

/**
 * Queues one Optimistic Action for a Mail Account. A queued action exactly
 * undone while still queued (star → unstar) drops both rows instead of
 * queuing a second one — that is already the Undo button's mechanism, and
 * ADR-0010 asks for nothing cleverer than this one trivial case.
 *
 * Wakes the sync loop (`requestSyncNow`, `sync/sync-loop.ts`) once the row
 * lands — ADR-0011: flushing the queue and syncing are one round trip, and
 * an Optimistic Action confirms "without waiting for the next poll", not up
 * to 30s later on the ordinary interval. Skipped on the coalesced-away path:
 * there is nothing new to flush, so nothing worth a round trip sooner than
 * the next one anyway.
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

  const id = await db.transaction("rw", db.pendingMutations, async () => {
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

    const newId = generateUlid();
    await db.pendingMutations.put({
      id: newId,
      mailAccountId,
      createdAt: new Date().toISOString(),
      referencedThreadIds: referencedThreadIds(intent),
      intent,
    });
    return newId;
  });

  if (id !== null) requestSyncNow();
  return id;
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
