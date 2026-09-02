import type { SyncRequest, SyncResponse } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/auth.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { createFakeLockManager } from "../test-support/fake-lock-manager.js";
import {
  createFakeEventSourceFactory,
  createFakeHintChannelFactory,
} from "../test-support/fake-sync-hints.js";
import { getSyncStatus, resetSyncStatus, type SyncLoopHandle, startSyncLoop } from "./sync-loop.js";

/**
 * Cadence, leader election and failure handling (ADR-0011). Only
 * `setTimeout` is faked: `fake-indexeddb` drives itself off the immediate
 * queue, and faking that would stall every cache write these rounds make.
 */

let counter = 0;
const names: string[] = [];
const loops: SyncLoopHandle[] = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  resetSyncStatus();
  const name = `sync-loop-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  for (const loop of loops.splice(0)) loop.stop();
  await settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

/**
 * Drains the real task queue the cache writes run on. Captured at import
 * time, before `useFakeTimers` swaps `setTimeout` out — otherwise draining
 * would need the very timers these tests control by hand.
 */
const realSetTimeout = globalThis.setTimeout;

async function settle(turns = 30): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

function countingSync() {
  const calls: SyncRequest[] = [];
  const post = (request: SyncRequest): Promise<SyncResponse> => {
    calls.push(request);
    return Promise.resolve({ user: {}, mailAccounts: {} });
  };
  return { post, calls };
}

function start(options: Parameters<typeof startSyncLoop>[0]): SyncLoopHandle {
  const loop = startSyncLoop(options);
  loops.push(loop);
  return loop;
}

describe("the sync loop", () => {
  it("syncs once on cold boot and again on the visible interval", async () => {
    const { post, calls } = countingSync();
    start({ post, locks: createFakeLockManager() });
    await settle();

    expect(calls).toHaveLength(1);

    await advance(30_000);
    expect(calls).toHaveLength(2);
  });

  it("does not open a second sync loop in a second tab", async () => {
    const locks = createFakeLockManager();
    const first = countingSync();
    const second = countingSync();

    start({ post: first.post, locks });
    start({ post: second.post, locks });
    await settle();
    await advance(30_000);

    expect(first.calls).toHaveLength(2);
    expect(second.calls).toHaveLength(0);
  });

  it("hands the loop to the other tab when the leader stops", async () => {
    const locks = createFakeLockManager();
    const first = countingSync();
    const second = countingSync();

    const leader = start({ post: first.post, locks });
    start({ post: second.post, locks });
    await settle();

    leader.stop();
    await settle();

    expect(second.calls).toHaveLength(1);
  });

  it("never polls while the tab is hidden", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { post, calls } = countingSync();
    start({ post, locks: createFakeLockManager() });
    await settle();

    expect(calls).toHaveLength(1); // the cold-boot round still runs

    await advance(120_000);
    expect(calls).toHaveLength(1);
  });

  it("syncs when the tab becomes visible again", async () => {
    const { post, calls } = countingSync();
    start({ post, locks: createFakeLockManager(), visibilityCooldownMs: 0 });
    await settle();

    document.dispatchEvent(new Event("visibilitychange"));
    await settle();

    expect(calls).toHaveLength(2);
  });

  it("rate-limits visibility triggers so alt-tabbing cannot hammer the endpoint", async () => {
    const { post, calls } = countingSync();
    start({ post, locks: createFakeLockManager() });
    await settle();

    for (let index = 0; index < 5; index++) {
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
    }

    expect(calls).toHaveLength(1);
  });
});

describe("when the Sync Backend is unreachable", () => {
  it("keeps the last state, stays silent, and retries on a backoff rather than immediately", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    const post = () => {
      attempts += 1;
      return Promise.reject(new TypeError("Failed to fetch"));
    };

    start({ post, locks: createFakeLockManager(), random: () => 0 });
    await settle();

    expect(attempts).toBe(1);
    expect(getSyncStatus()).toMatchObject({ failures: 1, lastError: "network_error" });

    // First backoff is 500ms with the jitter pinned to its floor — not the
    // 30s interval, and not a hot retry either.
    await advance(400);
    expect(attempts).toBe(1);
    await advance(200);
    expect(attempts).toBe(2);

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("backs off further with each consecutive failure", async () => {
    let attempts = 0;
    const post = () => {
      attempts += 1;
      return Promise.reject(new TypeError("Failed to fetch"));
    };
    start({ post, locks: createFakeLockManager(), random: () => 0 });
    await settle();

    await advance(500);
    expect(attempts).toBe(2);
    // Second failure's floor is 1000ms, so 500ms is no longer enough.
    await advance(500);
    expect(attempts).toBe(2);
    await advance(500);
    expect(attempts).toBe(3);
  });

  it("recovers to the ordinary interval once a round succeeds", async () => {
    let attempts = 0;
    const post = () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({ user: {}, mailAccounts: {} });
    };
    start({ post, locks: createFakeLockManager(), random: () => 0 });
    await settle();

    await advance(500);
    expect(getSyncStatus().failures).toBe(0);

    await advance(30_000);
    expect(attempts).toBe(3);
  });

  it("reports an expired session without wiping anything", async () => {
    const onUnauthorized = vi.fn();
    const post = () => Promise.reject(new ApiError(401, "unauthenticated"));

    start({ post, locks: createFakeLockManager(), onUnauthorized, random: () => 0 });
    await settle();

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(getSyncStatus().lastError).toBe("unauthenticated");
  });
});

describe("realtime Sync Hints (#52, ADR-0015)", () => {
  it("pulls immediately on a hint rather than waiting for the interval", async () => {
    const { post, calls } = countingSync();
    const es = createFakeEventSourceFactory();
    start({
      post,
      locks: createFakeLockManager(),
      sseOptions: { createEventSource: es.createEventSource },
    });
    await settle();
    expect(calls).toHaveLength(1); // the cold-boot round

    es.instances[0]?.fireHint();
    await settle();

    expect(calls).toHaveLength(2);
  });

  it("opens exactly one EventSource across two tabs, and hands it to the new leader when the first stops", async () => {
    const es = createFakeEventSourceFactory();
    const channel = createFakeHintChannelFactory();
    const locks = createFakeLockManager();
    const sseOptions = {
      createEventSource: es.createEventSource,
      createChannel: channel.createChannel,
    };

    const leader = start({ post: countingSync().post, locks, sseOptions });
    start({ post: countingSync().post, locks, sseOptions });
    await settle();

    expect(es.instances).toHaveLength(1);
    expect(es.instances[0]?.closed).toBe(false);

    leader.stop();
    await settle();

    expect(es.instances).toHaveLength(2);
    expect(es.instances[0]?.closed).toBe(true);
    expect(es.instances[1]?.closed).toBe(false);
  });

  it("relays a hint to a follower tab over BroadcastChannel", async () => {
    const es = createFakeEventSourceFactory();
    const channel = createFakeHintChannelFactory();
    const locks = createFakeLockManager();
    const sseOptions = {
      createEventSource: es.createEventSource,
      createChannel: channel.createChannel,
    };
    const { post: leaderPost, calls: leaderCalls } = countingSync();
    const { post: followerPost, calls: followerCalls } = countingSync();

    start({ post: leaderPost, locks, sseOptions });
    start({ post: followerPost, locks, sseOptions });
    await settle();

    es.instances[0]?.fireHint();
    await settle();

    // Only the leader ever talks to the network — a follower's reaction to
    // the relay is a no-op until it actually becomes the leader — but the
    // leader itself must have pulled off the *one* hint that fired.
    expect(leaderCalls.length).toBeGreaterThan(1);
    expect(followerCalls).toHaveLength(0);
  });
});
