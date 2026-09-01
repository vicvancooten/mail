import { ApiError } from "../api/auth.js";
import { claimLeadership, type LeaderHandle, type SyncLockManager } from "./leader.js";
import type { PostSync } from "./sync-api.js";
import { runSyncRound } from "./sync-round.js";

/**
 * The leader tab's sync loop and its cadence (ADR-0011): cold boot,
 * `visibilitychange → visible` (rate-limited so alt-tabbing cannot hammer
 * it), the `online` event, and a 30s interval **while visible only** — a
 * hidden tab polling is battery cost for nothing. SSE Sync Hints replace the
 * signal, not the mechanism, when #52 lands: `requestSync()` is the seam.
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
}

export interface SyncLoopHandle {
  /** Asks for a round as soon as the loop is free — the seam an SSE Sync Hint will use (#52). */
  requestSync(): void;
  stop(): void;
}

export function startSyncLoop(options: SyncLoopOptions = {}): SyncLoopHandle {
  const {
    intervalMs = SYNC_INTERVAL_MS,
    visibilityCooldownMs = VISIBILITY_COOLDOWN_MS,
    random = Math.random,
    post,
    onUnauthorized,
  } = options;

  let wake: (() => void) | null = null;
  let syncRequested = true; // the cold-boot round
  let lastRoundStartedAt: number | null = null;

  function requestSync(): void {
    syncRequested = true;
    wake?.();
  }

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
          // regained visible tab, a future SSE Sync Hint — is a reason to
          // sync. Only an abort leaves through the loop condition.
          syncRequested = true;
        }
      } finally {
        globalThis.removeEventListener?.("online", requestSyncThrottled);
        globalThis.document?.removeEventListener("visibilitychange", onVisibilityChange);
      }
    },
    { lockName: options.lockName, locks: options.locks },
  );

  return {
    requestSync,
    stop: () => {
      leader.release();
      wake?.();
    },
  };
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
