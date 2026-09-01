import type { MutationOutcome, SyncRequest, SyncResponse } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readThreadWindow } from "../store/index.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import {
  enqueueMutation,
  listQueuedMutations,
  type MutationRejection,
  subscribeMutationRejections,
} from "../store/mutation-queue.js";
import { getSyncToken, threadTokenKey } from "../store/server-writes.js";
import {
  delta,
  makeMailAccount,
  makeThread,
  minutesAfterEpoch,
} from "../test-support/mail-fixtures.js";
import { runSyncRound } from "./sync-round.js";

let counter = 0;
let cacheName = "";
const names: string[] = [];

beforeEach(async () => {
  cacheName = `sync-round-test-${counter++}`;
  names.push(cacheName);
  await openLocalCache({ name: cacheName, schemaVersion: 1 });
});

afterEach(async () => {
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

/** A scripted `POST /sync`, recording every request it was asked. */
function scriptedSync(responses: SyncResponse[]) {
  const requests: SyncRequest[] = [];
  const queue = [...responses];
  const post = (request: SyncRequest): Promise<SyncResponse> => {
    requests.push(structuredClone(request));
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected extra POST /sync: ${JSON.stringify(request)}`);
    return Promise.resolve(next);
  };
  return { post, requests };
}

describe("runSyncRound", () => {
  it("bootstraps with null tokens and asks about the accounts it just learned of", async () => {
    const { post, requests } = scriptedSync([
      {
        user: { MailAccount: delta({ created: [makeMailAccount("acct-1")], newState: "ma-1" }) },
        mailAccounts: {},
      },
      {
        user: {},
        mailAccounts: {
          "acct-1": { Thread: delta({ created: [makeThread("t1", "acct-1")], newState: "th-1" }) },
        },
      },
    ]);

    const result = await runSyncRound(post);

    expect(requests[0]).toEqual({ user: { MailAccount: null }, mailAccounts: {} });
    expect(requests[1]).toEqual({
      user: { MailAccount: "ma-1" },
      mailAccounts: { "acct-1": { Thread: null } },
    });
    expect(result.pages).toBe(2);
    expect((await readThreadWindow("acct-1")).threads.map((thread) => thread.id)).toEqual(["t1"]);
  });

  it("keeps paging while a collection says hasMore, resuming from the token it was given", async () => {
    const { post, requests } = scriptedSync([
      {
        user: { MailAccount: delta({ created: [makeMailAccount("acct-1")], newState: "ma-1" }) },
        mailAccounts: {},
      },
      {
        user: {},
        mailAccounts: {
          "acct-1": {
            Thread: delta({
              created: [makeThread("t1", "acct-1", { lastMessageAt: minutesAfterEpoch(1) })],
              newState: "th-1",
              hasMore: true,
            }),
          },
        },
      },
      {
        user: {},
        mailAccounts: {
          "acct-1": {
            Thread: delta({
              created: [makeThread("t2", "acct-1", { lastMessageAt: minutesAfterEpoch(2) })],
              newState: "th-2",
            }),
          },
        },
      },
    ]);

    await runSyncRound(post);

    expect(requests[2]?.mailAccounts?.["acct-1"]).toEqual({ Thread: "th-1" });
    expect(await getSyncToken(threadTokenKey("acct-1"))).toBe("th-2");
    expect((await readThreadWindow("acct-1")).threads.map((thread) => thread.id)).toEqual([
      "t2",
      "t1",
    ]);
  });

  it("discards on the first page of a reset replay and merges the rest of it", async () => {
    const bootstrap = scriptedSync([
      {
        user: { MailAccount: delta({ created: [makeMailAccount("acct-1")], newState: "ma-1" }) },
        mailAccounts: {},
      },
      {
        user: {},
        mailAccounts: {
          "acct-1": {
            Thread: delta({ created: [makeThread("stale", "acct-1")], newState: "th-1" }),
          },
        },
      },
    ]);
    await runSyncRound(bootstrap.post);

    const replay = scriptedSync([
      {
        user: {},
        mailAccounts: {
          "acct-1": {
            Thread: delta({
              created: [makeThread("fresh-1", "acct-1", { lastMessageAt: minutesAfterEpoch(1) })],
              newState: "th-2",
              hasMore: true,
              reset: true,
            }),
          },
        },
      },
      {
        user: {},
        mailAccounts: {
          "acct-1": {
            Thread: delta({
              created: [makeThread("fresh-2", "acct-1", { lastMessageAt: minutesAfterEpoch(2) })],
              newState: "th-3",
              reset: true,
            }),
          },
        },
      },
    ]);
    await runSyncRound(replay.post);

    expect((await readThreadWindow("acct-1")).threads.map((thread) => thread.id)).toEqual([
      "fresh-2",
      "fresh-1",
    ]);
  });

  it("re-bootstraps every collection after a schema wipe", async () => {
    const bootstrap = scriptedSync([
      {
        user: { MailAccount: delta({ created: [makeMailAccount("acct-1")], newState: "ma-1" }) },
        mailAccounts: {},
      },
      {
        user: {},
        mailAccounts: {
          "acct-1": { Thread: delta({ created: [makeThread("t1", "acct-1")], newState: "th-1" }) },
        },
      },
    ]);
    await runSyncRound(bootstrap.post);

    expect(await openLocalCache({ name: cacheName, schemaVersion: 2 })).toMatchObject({
      status: "wiped",
    });

    const resync = scriptedSync([
      {
        user: { MailAccount: delta({ created: [makeMailAccount("acct-1")], newState: "ma-2" }) },
        mailAccounts: {},
      },
      {
        user: {},
        mailAccounts: {
          "acct-1": { Thread: delta({ created: [makeThread("t1", "acct-1")], newState: "th-2" }) },
        },
      },
    ]);
    await runSyncRound(resync.post);

    // Both tokens went with the wipe, so this is a bootstrap and not a delta
    // resumed from a cursor whose rows no longer exist locally.
    expect(resync.requests[0]).toEqual({ user: { MailAccount: null }, mailAccounts: {} });
    expect(resync.requests[1]?.mailAccounts?.["acct-1"]).toEqual({ Thread: null });
    expect((await readThreadWindow("acct-1")).threads.map((thread) => thread.id)).toEqual(["t1"]);
  });

  it("flushes only the mutation queue while a schema wipe waits, fetching no collection", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    const id = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      "acct-1",
    );
    await openLocalCache({ name: cacheName, schemaVersion: 2 });

    const { post, requests } = scriptedSync([
      {
        user: {},
        mailAccounts: { "acct-1": { mutations: [{ id: id as string, status: "applied" }] } },
      },
    ]);
    const result = await runSyncRound(post);

    expect(result).toEqual({ deferred: true, pages: 1, changed: false });
    // No `user`/Thread token requested — those tokens are about to be
    // discarded by the wipe this drain unblocks.
    expect(requests[0]?.user).toBeUndefined();
    expect(requests[0]?.mailAccounts?.["acct-1"]?.Thread).toBeUndefined();
    expect(requests[0]?.mailAccounts?.["acct-1"]?.mutations).toEqual([
      { id, intent: { type: "setStarred", threadId: "t1", starred: true } },
    ]);
    // The queue drained; the old (pre-wipe) data otherwise stays untouched.
    expect(await listQueuedMutations("acct-1")).toEqual([]);
    expect(await localCache().mailAccounts.count()).toBe(1);
  });

  it("retries the wipe on the next round once the drain from the previous one completes", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    const id = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      "acct-1",
    );
    await openLocalCache({ name: cacheName, schemaVersion: 2 });

    await runSyncRound(
      scriptedSync([
        {
          user: {},
          mailAccounts: { "acct-1": { mutations: [{ id: id as string, status: "applied" }] } },
        },
      ]).post,
    );

    // The queue is empty now, so this round's `reconcileCacheSchema` call
    // finally performs the deferred wipe and re-bootstraps like any other
    // schema bump.
    const resync = scriptedSync([{ user: {}, mailAccounts: {} }]);
    const result = await runSyncRound(resync.post);

    expect(result.deferred).toBe(false);
    expect(await localCache().mailAccounts.count()).toBe(0);
  });

  it("holds the queue with zero network calls when every account behind it is Needs Reauth", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1", { status: "needs_reauth" }));
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, "acct-1");
    await openLocalCache({ name: cacheName, schemaVersion: 2 });

    const { post, requests } = scriptedSync([]);
    const result = await runSyncRound(post);

    expect(result).toEqual({ deferred: true, pages: 0, changed: false });
    expect(requests).toHaveLength(0);
    expect(await listQueuedMutations("acct-1")).toHaveLength(1);
  });
});

describe("runSyncRound — Optimistic Action queue flush", () => {
  it("sends a Mail Account's queue in FIFO order on the round's first request only", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    const first = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      "acct-1",
    );
    const second = await enqueueMutation(
      { type: "setRead", threadId: "t2", read: false },
      "acct-1",
    );

    const { post, requests } = scriptedSync([{ user: {}, mailAccounts: {} }]);
    await runSyncRound(post);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.mailAccounts?.["acct-1"]?.mutations).toEqual([
      { id: first, intent: { type: "setStarred", threadId: "t1", starred: true } },
      { id: second, intent: { type: "setRead", threadId: "t2", read: false } },
    ]);
  });

  it("dequeues on `applied` — draining exactly once, never resent on the next round", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    const id = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      "acct-1",
    );

    await runSyncRound(
      scriptedSync([
        {
          user: {},
          mailAccounts: { "acct-1": { mutations: [{ id: id as string, status: "applied" }] } },
        },
      ]).post,
    );
    expect(await listQueuedMutations("acct-1")).toEqual([]);

    // A second round with nothing queued must not send `mutations` at all.
    const second = scriptedSync([{ user: {}, mailAccounts: {} }]);
    await runSyncRound(second.post);
    expect(second.requests[0]?.mailAccounts?.["acct-1"]?.mutations).toBeUndefined();
  });

  it("survives offline: a request that never gets a response leaves the queue untouched", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    const id = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      "acct-1",
    );

    const offline = () => Promise.reject(new Error("network error"));
    await expect(runSyncRound(offline)).rejects.toThrow("network error");

    // Nothing was dequeued — there was no response to dequeue it on.
    const queued = await listQueuedMutations("acct-1");
    expect(queued.map((mutation) => mutation.id)).toEqual([id]);

    // Back online: the very same row flushes on the next round, unharmed.
    await runSyncRound(
      scriptedSync([
        {
          user: {},
          mailAccounts: { "acct-1": { mutations: [{ id: id as string, status: "applied" }] } },
        },
      ]).post,
    );
    expect(await listQueuedMutations("acct-1")).toEqual([]);
  });

  it("rolls back a rejected mutation — the row is deleted and a rejection listener is notified", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    const id = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      "acct-1",
    );

    const rejections: MutationRejection[] = [];
    const unsubscribe = subscribeMutationRejections((rejection) => rejections.push(rejection));

    await runSyncRound(
      scriptedSync([
        {
          user: {},
          mailAccounts: {
            "acct-1": {
              mutations: [{ id: id as string, status: "rejected", reason: "thread_not_found" }],
            },
          },
        },
      ]).post,
    );
    unsubscribe();

    expect(await listQueuedMutations("acct-1")).toEqual([]);
    expect(rejections).toEqual([
      {
        mailAccountId: "acct-1",
        intent: { type: "setStarred", threadId: "t1", starred: true },
        reason: "thread_not_found",
      },
    ]);
  });

  it("keeps a mutation queued when the response never answers for it", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    const id = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      "acct-1",
    );

    // A defensive shape-mismatch: the account entry is present (matching
    // `askedAbout`) but carries no `mutations` at all.
    await runSyncRound(scriptedSync([{ user: {}, mailAccounts: { "acct-1": {} } }]).post);

    expect((await listQueuedMutations("acct-1")).map((mutation) => mutation.id)).toEqual([id]);
  });

  it("never sends a Needs Reauth account's queue, while a co-queued active account still flushes", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    await localCache().mailAccounts.put(makeMailAccount("acct-2", { status: "needs_reauth" }));
    const activeId = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      "acct-1",
    );
    await enqueueMutation({ type: "setStarred", threadId: "t2", starred: true }, "acct-2");

    const { post, requests } = scriptedSync([
      {
        user: {},
        mailAccounts: { "acct-1": { mutations: [{ id: activeId as string, status: "applied" }] } },
      },
    ]);
    await runSyncRound(post);

    for (const request of requests) {
      expect(request.mailAccounts?.["acct-2"]?.mutations).toBeUndefined();
    }
    expect(await listQueuedMutations("acct-1")).toEqual([]);
    expect(await listQueuedMutations("acct-2")).toHaveLength(1);
  });

  it("survives a reload — closing and reopening the same cache — then drains exactly once", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    const id = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      "acct-1",
    );

    // A page reload: the same IndexedDB database reopens at the same
    // schema version — nothing wipes, and the queued row is right there.
    localCache().close();
    expect(await openLocalCache({ name: cacheName, schemaVersion: 1 })).toEqual({
      status: "current",
    });
    const reloaded = await listQueuedMutations("acct-1");
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.id).toBe(id);

    await runSyncRound(
      scriptedSync([
        {
          user: {},
          mailAccounts: { "acct-1": { mutations: [{ id: id as string, status: "applied" }] } },
        },
      ]).post,
    );
    expect(await listQueuedMutations("acct-1")).toEqual([]);
  });

  it("carries the mutation-flush response's Thread delta in the same round trip (ADR-0011's third divergence)", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    const id = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      "acct-1",
    );

    const { post } = scriptedSync([
      {
        user: {},
        mailAccounts: {
          "acct-1": {
            Thread: delta({
              created: [makeThread("t1", "acct-1", { starred: true })],
              newState: "th-1",
            }),
            mutations: [{ id: id as string, status: "applied" } satisfies MutationOutcome],
          },
        },
      },
    ]);
    await runSyncRound(post);

    expect(await listQueuedMutations("acct-1")).toEqual([]);
    expect((await readThreadWindow("acct-1")).threads[0]?.starred).toBe(true);
  });
});
