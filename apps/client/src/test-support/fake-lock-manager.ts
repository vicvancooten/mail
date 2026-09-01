import type { SyncLockManager } from "../sync/leader.js";

/**
 * An in-memory Web Locks stand-in with the one property the leader election
 * relies on: an exclusive name is held by one holder, and everyone else
 * queues until it is released. jsdom has no `navigator.locks`, and a stub
 * that simply grants every request would let a two-tab test pass while the
 * real thing ran two sync loops.
 */
export function createFakeLockManager(): SyncLockManager {
  const held = new Set<string>();
  const queues = new Map<string, (() => void)[]>();

  function release(name: string): void {
    held.delete(name);
    const next = queues.get(name)?.shift();
    if (next) next();
  }

  function acquire(name: string, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!held.has(name)) {
      held.add(name);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        held.add(name);
        resolve();
      };
      const queue = queues.get(name) ?? [];
      queue.push(grant);
      queues.set(name, queue);

      signal?.addEventListener(
        "abort",
        () => {
          const pending = queues.get(name);
          const index = pending?.indexOf(grant) ?? -1;
          if (index >= 0) {
            pending?.splice(index, 1);
            reject(abortError());
          }
        },
        { once: true },
      );
    });
  }

  return {
    async request(name, options, callback) {
      await acquire(name, options.signal);
      try {
        return await callback();
      } finally {
        release(name);
      }
    },
  };
}

function abortError(): Error {
  const error = new Error("The lock request was aborted");
  error.name = "AbortError";
  return error;
}
