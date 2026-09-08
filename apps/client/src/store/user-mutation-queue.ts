import type { MutationOutcome, UserMutationIntent } from "@mail/shared";
import { normalizeLabelName } from "@mail/shared";
import { requestSyncNow } from "../sync/sync-loop.js";
import type { PendingUserMutation } from "./db.js";
import { localCache } from "./local-cache.js";
import { generateUlid } from "./ulid.js";

/**
 * The User-scoped Optimistic Action queue's only writers (#54), mirroring
 * `mutation-queue.ts`'s split for the per-Mail-Account queue: components
 * enqueue a `Preference` edit — or, since #192, a Note structural intent —
 * here, `sync/` is the only reader that flushes and dequeues it. There is no
 * `mailAccountId`/`referencedThreadIds` to carry — nothing here is ever about
 * a Thread, and Needs Reauth (a Mail Account concept) never applies to a
 * User-scoped edit.
 *
 * Two coalescing shapes share one queue, told apart by `coalesceKey` below:
 * a `Preference` field is an absolute set with no natural inverse, so a
 * second edit to the same field while the first is still queued **replaces**
 * it outright — "the User changed their mind again before it went out". A
 * Note structural intent (#192, ADR-0019) *does* have a real inverse
 * (`createNote`/`deleteNote`, `labelNote`/`unlabelNote`), so a still-queued
 * original meeting its own inverse **cancels both away** instead — the same
 * trick `mutation-queue.ts#enqueueMutation` already plays for the
 * per-Thread queue, generalized here to whichever of the two a given intent
 * kind calls for.
 *
 * Wakes the sync loop (`requestSyncNow`, `sync/sync-loop.ts`) once the row
 * lands — ADR-0011: flushing the queue and syncing are one round trip, and
 * an Optimistic Action confirms "without waiting for the next poll", not up
 * to 30s later on the ordinary interval. Called even on the cancelled-away
 * path: there is nothing new to flush, but a still-queued original this
 * cancelled may itself be worth flushing sooner (harmless, `requestSyncNow`
 * is idempotent either way).
 */

/**
 * What "about the same thing" means for one intent (the grouping key a
 * later edit/inverse is matched against) — every `Preference` field gets a
 * fixed, type-only key (there is exactly one of each per User, so `type`
 * alone is a unique enough bucket); a Note intent's key names the Note (and,
 * for a Label, the normalized name too), the same per-entity granularity
 * `mutation-queue.ts#coalesceKey` uses for a Thread.
 */
function coalesceKey(intent: UserMutationIntent): {
  type: string;
  targetId: string;
  value: boolean;
} {
  switch (intent.type) {
    case "setAutoAdvance":
    case "setUndoSendDelay":
    case "setHomeTimeZone":
      return { type: intent.type, targetId: intent.type, value: true };
    // `createNote`/`deleteNote` (#192, ADR-0019) are a genuine inverse pair,
    // the same shape `mutation-queue.ts`'s `discardComposition`/
    // `undiscardComposition` bucket already has.
    case "createNote":
      return { type: "note", targetId: intent.noteId, value: true };
    case "deleteNote":
      return { type: "note", targetId: intent.noteId, value: false };
    // `labelNote`/`unlabelNote` (#192) share one bucket keyed on
    // `noteId:name`, the same `applyLabel`/`removeLabel` shape
    // `mutation-queue.ts`'s own `"label"` bucket already has.
    case "labelNote":
      return {
        type: "noteLabel",
        targetId: `${intent.noteId}:${normalizeLabelName(intent.name)}`,
        value: true,
      };
    case "unlabelNote":
      return {
        type: "noteLabel",
        targetId: `${intent.noteId}:${normalizeLabelName(intent.name)}`,
        value: false,
      };
  }
}

/**
 * Queues one User-scoped Optimistic Action. Any still-queued row about the
 * same thing (`coalesceKey`) is superseded outright; if that row was also
 * this intent's exact inverse, nothing new is queued either — the pair
 * cancels away, the Sync Backend never hears about either half. Returns the
 * new mutation's id, or `null` on the cancelled-away path.
 */
export async function enqueueUserMutation(intent: UserMutationIntent): Promise<string | null> {
  const db = localCache();
  const key = coalesceKey(intent);

  const id = await db.transaction("rw", db.pendingUserMutations, async () => {
    const sameTarget = (await db.pendingUserMutations.toArray()).filter((mutation) => {
      const candidateKey = coalesceKey(mutation.intent);
      return candidateKey.type === key.type && candidateKey.targetId === key.targetId;
    });
    if (sameTarget.length > 0) {
      await db.pendingUserMutations.bulkDelete(sameTarget.map((mutation) => mutation.id));
    }

    const isInverse = sameTarget.some(
      (mutation) => coalesceKey(mutation.intent).value !== key.value,
    );
    if (isInverse) return null;

    const newId = generateUlid();
    await db.pendingUserMutations.put({ id: newId, createdAt: new Date().toISOString(), intent });
    return newId;
  });

  requestSyncNow();
  return id;
}

/** The whole queue, oldest first (ADR-0010: strict FIFO, same as the per-Mail-Account queue). */
export async function listQueuedUserMutations(): Promise<PendingUserMutation[]> {
  return localCache().pendingUserMutations.orderBy("id").toArray();
}

/**
 * Same shape as `resolveMutationOutcomes` (`mutation-queue.ts`): applied and
 * rejected outcomes both dequeue. Every `UserMutationIntent` variant is an
 * unconditional set (`sync.ts#userMutationIntentSchema`'s own doc comment),
 * so unlike the Thread queue there is no rejection worth a toast over — a
 * `rejected` outcome here would only ever mean this specific User row is
 * gone, not that the edit itself was wrong.
 */
export async function resolveUserMutationOutcomes(outcomes: MutationOutcome[]): Promise<void> {
  for (const outcome of outcomes) {
    await localCache().pendingUserMutations.delete(outcome.id);
  }
}
