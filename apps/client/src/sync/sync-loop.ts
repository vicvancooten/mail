import { ApiError } from "../api/auth.js";
import { claimLeadership, type LeaderHandle, type SyncLockManager } from "./leader.js";
import {
  type ConnectSyncHintsOptions,
  connectSyncHints,
  type SubscribeSyncHintsOptions,
  subscribeSyncHints,
} from "./sse.js";
import type { PostSync } from "./sync-api.js";
import { runSyncRound } from "./sync-round.js";

/**
 * The leader tab's sync loop and its cadence (ADR-0011): cold boot,
 * `visibilitychange → visible` (rate-limited so alt-tabbing cannot hammer
 * it), the `online` event, an SSE Sync Hint (ADR-0015, `sse.ts`), and a 30s
 * interval **while visible only** — a hidden tab polling is battery cost for
 * nothing, and the interval survives as the safety net a missed or
 * never-arrived hint heals against. `requestSync()` is the one seam all of
 * these wake through.
 *
 * The `GET /events` connection itself only ever opens inside the Web Locks
 * leader task below — never per-tab — and every tab, leader included,
 * reacts to a hint through `subscribeSyncHints`'s `BroadcastChannel` rather
 * than a direct call, so there is one reaction to keep correct instead of a
 * leader path and a follower path.
 *
 * The Client is **silent when healthy**. Nothing here logs, and nothing here
 * renders: a failure moves `SyncStatus`, and a future offline indicator is
 * the only thing that reads it.
 */

export const SYNC_INTERVAL_MS = 30_000;
/** Alt-tabbing back within this window rides the last round rather than starting one. */
export const VISIBILITY_COOLDOWN_MS = 5_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export interface SyncStatus {
  /** Consecutive failed rounds; `0` while healthy, which is the state the UI says nothing about. */
  failures: number;
  /** The last failure's code (an `ApiError` code, or `network_error`), while `failures > 0`. */
  lastError: string | null;
  /** True while a schema wipe waits on the Optimistic Action queue to drain (ADR-0009). */
  schemaWipeDeferred: boolean;
  /** `Date.now()` of the last round that completed, cache-warm or not. */
  lastSyncedAt: number | null;
}

const HEALTHY: SyncStatus = {
  failures: 0,
  lastError: null,
  schemaWipeDeferred: false,
  lastSyncedAt: null,
};

let status: SyncStatus = HEALTHY;
const statusListeners = new Set<(status: SyncStatus) => void>();

export function getSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSyncStatus(listener: (status: SyncStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function setStatus(next: SyncStatus): void {
  status = next;
  for (const listener of statusListeners) listener(next);
}

export interface SyncLoopOptions {
  intervalMs?: number;
  visibilityCooldownMs?: number;
  lockName?: string;
  locks?: SyncLockManager | null;
  post?: PostSync;
  /** Jitter source, injected so a test can assert an exact backoff delay. */
  random?: () => number;
  /**
   * Called when the Sync Backend rejects the session. The Local Cache is
   * never wiped for this (poc-spec.md): the Client degrades to a login
   * prompt over last state.
   */
  onUnauthorized?: () => void;
  /** Test seam for `sse.ts`'s `subscribeSyncHints` — every tab's reaction to a relayed hint. */
  subscribeHints?: typeof subscribeSyncHints;
  /** Test seam for `sse.ts`'s `connectSyncHints` — the leader-only `GET /events` connection. */
  connectHints?: typeof connectSyncHints;
  sseOptions?: SubscribeSyncHintsOptions & ConnectSyncHintsOptions;
}

export interface SyncLoopHandle {
  /** Asks for a round as soon as the loop is free — the seam an SSE Sync Hint uses (#52). */
  requestSync(): void;
  stop(): void;
}

/**
 * The live loop's `requestSync`, reachable without threading a handle through
 * the component tree. The Undo Send bar (#46) is what needs it: a send and a
 * cancel are both worth a round trip *now* rather than on the next 30s tick,
 * because a 10-second Undo window that takes 30 seconds to start or to
 * cancel is not an Undo window. An SSE Sync Hint relayed over `sse.ts`'s
 * `BroadcastChannel` calls the same seam.
 *
 * `null` while no loop is running, and a no-op in a tab that lost the Web
 * Lock — a follower tab has no loop to wake, only a hint reaction that sets
 * a flag nothing is reading yet.
 */
let activeLoop: SyncLoopHandle | null = null;

export function requestSyncNow(): void {
  activeLoop?.requestSync();
}

export function startSyncLoop(options: SyncLoopOptions = {}): SyncLoopHandle {
  const {
    intervalMs = SYNC_INTERVAL_MS,
    visibilityCooldownMs = VISIBILITY_COOLDOWN_MS,
    random = Math.random,
    post,
    onUnauthorized,
    subscribeHints = subscribeSyncHints,
    connectHints = connectSyncHints,
    sseOptions,
  } = options;

  let wake: (() => void) | null = null;
  let syncRequested = true; // the cold-boot round
  let lastRoundStartedAt: number | null = null;

  function requestSync(): void {
    syncRequested = true;
    wake?.();
  }

  // Every tab reacts to a relayed hint the same way, leader included — see
  // `sse.ts`'s doc comment for why a leader can't just call `requestSync`
  // and skip this: it exists for the day another tab held the connection
  // before this one won leadership.
  const unsubscribeHints = subscribeHints(requestSync, sseOptions);

  /** Rate-limited so a burst of `visible`/`online` events cannot hammer the endpoint. */
  function requestSyncThrottled(): void {
    if (lastRoundStartedAt !== null && Date.now() - lastRoundStartedAt < visibilityCooldownMs) {
      return;
    }
    requestSync();
  }

  function onVisibilityChange(): void {
    if (isVisible()) requestSyncThrottled();
  }

  const leader: LeaderHandle = claimLeadership(
    async (signal) => {
      globalThis.addEventListener?.("online", requestSyncThrottled);
      globalThis.document?.addEventListener("visibilitychange", onVisibilityChange);
      // The one `GET /events` connection for the whole User (ADR-0015):
      // only the tab that wins the Web Lock ever opens it, and it closes
      // the moment this tab's leadership does, on `signal` abort.
      connectHints(requestSync, signal, sseOptions);
      try {
        while (!signal.aborted) {
          if (syncRequested) {
            syncRequested = false;
            lastRoundStartedAt = Date.now();
            await runRound(post, onUnauthorized);
          }
          if (signal.aborted) break;
          await waitForWake(signal, nextDelayMs(intervalMs, random), (resolve) => {
            wake = resolve;
          });
          wake = null;
          // Whatever woke this — the interval, a backoff, `online`, a
          // regained visible tab, an SSE Sync Hint — is a reason to sync.
          // Only an abort leaves through the loop condition.
          syncRequested = true;
        }
      } finally {
        globalThis.removeEventListener?.("online", requestSyncThrottled);
        globalThis.document?.removeEventListener("visibilitychange", onVisibilityChange);
      }
    },
    { lockName: options.lockName, locks: options.locks },
  );

  const handle: SyncLoopHandle = {
    requestSync,
    stop: () => {
      if (activeLoop === handle) activeLoop = null;
      unsubscribeHints();
      leader.release();
      wake?.();
    },
  };
  activeLoop = handle;
  return handle;
}

async function runRound(post: PostSync | undefined, onUnauthorized: (() => void) | undefined) {
  try {
    const result = await runSyncRound(post);
    setStatus({
      failures: 0,
      lastError: null,
      schemaWipeDeferred: result.deferred,
      lastSyncedAt: Date.now(),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) onUnauthorized?.();
    setStatus({
      ...status,
      failures: status.failures + 1,
      lastError: error instanceof ApiError ? error.code : "network_error",
    });
  }
}

/**
 * `null` means "sleep until something wakes us". Never polling while hidden
 * is the rule; a failing round backs off exponentially with jitter to a ~60s
 * cap rather than retrying on the ordinary interval.
 */
function nextDelayMs(intervalMs: number, random: () => number): number | null {
  if (!isVisible()) return null;
  if (status.failures === 0) return intervalMs;
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (status.failures - 1));
  return ceiling / 2 + random() * (ceiling / 2);
}

function waitForWake(
  signal: AbortSignal,
  delayMs: number | null,
  register: (resolve: () => void) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = delayMs === null ? null : setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    register(finish);
  });
}

/** A host with no `document` (a worker, a test double) counts as visible: it has no tab to hide. */
function isVisible(): boolean {
  return globalThis.document?.visibilityState !== "hidden";
}

/** Test seam: the module-level status outlives a loop, so each test starts from healthy. */
export function resetSyncStatus(): void {
  setStatus(HEALTHY);
}
