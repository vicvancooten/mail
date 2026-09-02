/**
 * One tab owns the sync loop, elected with the Web Locks API (ADR-0010).
 * `SharedWorker` would have been the clean answer and is out on a hard fact:
 * Chrome for Android doesn't support it, and the phone PWA is in scope.
 *
 * A Web Lock auto-releases when its tab dies, so failover needs no
 * heartbeats: a follower's request simply sits in the queue until the leader
 * goes away, and then it *is* the leader. Dexie's `liveQuery` already
 * propagates writes cross-tab, so followers stay live with no extra
 * machinery — they just don't talk to the network.
 */

export const SYNC_LEADER_LOCK = "mail:sync-leader";

/**
 * The leader's work. **Must resolve once `signal` aborts** — the Web Lock is
 * held for exactly as long as this promise is pending, and `AbortSignal`
 * does not release an already-granted lock on its own. It must also not
 * reject: a leader that throws hands leadership to a follower silently.
 */
export type LeaderTask = (signal: AbortSignal) => Promise<void>;

export interface LeaderHandle {
  /** Aborts the task and releases the lock (or withdraws a still-queued claim). */
  release(): void;
}

/**
 * The slice of the Web Locks API this needs. `navigator.locks` satisfies it,
 * and so can a test double — narrowing here beats casting a fake into the
 * full `LockManager` overload set.
 */
export interface SyncLockManager {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown>;
}

export interface ClaimLeadershipOptions {
  lockName?: string;
  /** Defaults to `navigator.locks`. `null` states "this host has none", which tests use to reach the fallback deliberately. */
  locks?: SyncLockManager | null;
}

export function claimLeadership(
  task: LeaderTask,
  { lockName = SYNC_LEADER_LOCK, locks = globalThis.navigator?.locks }: ClaimLeadershipOptions = {},
): LeaderHandle {
  const controller = new AbortController();

  if (!locks) {
    // No Web Locks (an old browser, or a non-DOM host): run the task rather
    // than never syncing. The failure mode is duplicate polling across tabs,
    // which is wasteful but not incorrect — every write is idempotent.
    void task(controller.signal).catch(() => {});
    return { release: () => controller.abort() };
  }

  void locks
    .request(lockName, { signal: controller.signal }, async () => {
      if (controller.signal.aborted) return;
      await task(controller.signal);
    })
    // An `AbortError` here is the ordinary follower path: this tab was still
    // queued behind the leader when it was told to stop.
    .catch(() => {});

  return { release: () => controller.abort() };
}
