import type { MutationOutcome, UserMutationIntent } from "@mail/shared";
import type { PendingUserMutation } from "./db.js";
import { localCache } from "./local-cache.js";
import { generateUlid } from "./ulid.js";

/**
 * The User-scoped Optimistic Action queue's only writers (#54), mirroring
 * `mutation-queue.ts`'s split for the per-Mail-Account queue: components
 * enqueue a `Preference` edit here, `sync/` is the only reader that flushes
 * and dequeues it. There is no `mailAccountId`/`referencedThreadIds` to carry
 * — nothing here is ever about a Thread, and Needs Reauth (a Mail Account
 * concept) never applies to a User-scoped edit.
 *
 * Coalescing is simpler than the per-Thread queue's, and deliberately more
 * aggressive: every `UserMutationIntent` is an absolute set on one
 * `Preference` field (its own doc comment in `@mail/shared`), so a second
 * edit to the same field while the first is still queued can only ever mean
 * "the User changed their mind again before it went out" — the earlier row
 * is simply replaced, not queued alongside it.
 */

export async function enqueueUserMutation(intent: UserMutationIntent): Promise<string> {
  const db = localCache();
  return db.transaction("rw", db.pendingUserMutations, async () => {
    const superseded = await db.pendingUserMutations
      .filter((mutation) => mutation.intent.type === intent.type)
      .primaryKeys();
    if (superseded.length > 0) await db.pendingUserMutations.bulkDelete(superseded);

    const id = generateUlid();
    await db.pendingUserMutations.put({ id, createdAt: new Date().toISOString(), intent });
    return id;
  });
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
