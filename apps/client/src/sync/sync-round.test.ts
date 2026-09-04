import type { MutationOutcome, SyncRequest, SyncResponse } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_COMPOSE_CONTENT,
  listQueuedComposeSaves,
  saveComposition,
} from "../store/compositions.js";
import { readPreference, readThreadWindow } from "../store/index.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import {
  enqueueMutation,
  listQueuedMutations,
  type MutationRejection,
  subscribeMutationRejections,
} from "../store/mutation-queue.js";
import { applyThreadDelta, getSyncToken, threadTokenKey } from "../store/server-writes.js";
import { enqueueUserMutation, listQueuedUserMutations } from "../store/user-mutation-queue.js";
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

    expect(requests[0]).toEqual({
      user: { MailAccount: null, Preference: null },
      mailAccounts: {},
    });
    expect(requests[1]).toEqual({
      user: { MailAccount: "ma-1", Preference: null },
      mailAccounts: {
        "acct-1": { Thread: null, Label: null, Composition: null, Correspondent: null },
      },
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

    expect(requests[2]?.mailAccounts?.["acct-1"]).toEqual({
      Thread: "th-1",
      Label: null,
      Composition: null,
      Correspondent: null,
    });
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
    expect(resync.requests[0]).toEqual({
      user: { MailAccount: null, Preference: null },
      mailAccounts: {},
    });
    expect(resync.requests[1]?.mailAccounts?.["acct-1"]).toEqual({
      Thread: null,
      Label: null,
      Composition: null,
      Correspondent: null,
    });
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

  it("archive: survives offline, drains on reconnect, and a forced rejection rolls back visibly (#42)", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    await applyThreadDelta("acct-1", delta({ created: [makeThread("t1", "acct-1")] }), {
      replace: false,
    });
    const id = await enqueueMutation({ type: "archive", threadId: "t1" }, "acct-1");

    expect((await readThreadWindow("acct-1")).threads).toEqual([]); // hidden the instant it's queued

    // Offline: the request never gets a response, so nothing dequeues.
    await expect(runSyncRound(() => Promise.reject(new Error("network error")))).rejects.toThrow(
      "network error",
    );
    expect((await listQueuedMutations("acct-1")).map((mutation) => mutation.id)).toEqual([id]);
    expect((await readThreadWindow("acct-1")).threads).toEqual([]); // still hidden while offline

    // Back online, but the Sync Backend forces a rejection (no Archive
    // folder on this account, say) — the queue drains, and the Thread
    // reappears rather than staying hidden with nothing to show for it.
    await runSyncRound(
      scriptedSync([
        {
          user: {},
          mailAccounts: {
            "acct-1": {
              mutations: [{ id: id as string, status: "rejected", reason: "no_archive_folder" }],
            },
          },
        },
      ]).post,
    );

    expect(await listQueuedMutations("acct-1")).toEqual([]);
    expect((await readThreadWindow("acct-1")).threads.map((thread) => thread.id)).toEqual(["t1"]);
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

describe("runSyncRound — User-scoped Preference queue flush (#54)", () => {
  it("sends the User-scoped queue on the round's first request only", async () => {
    const id = await enqueueUserMutation({
      type: "setAutoAdvance",
      enabled: false,
      direction: "newer",
    });

    const { post, requests } = scriptedSync([{ user: {}, mailAccounts: {} }]);
    await runSyncRound(post);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.user?.mutations).toEqual([
      { id, intent: { type: "setAutoAdvance", enabled: false, direction: "newer" } },
    ]);
  });

  it("dequeues on `applied`, and applies the Preference delta the same round trip", async () => {
    const id = await enqueueUserMutation({
      type: "setAutoAdvance",
      enabled: false,
      direction: "newer",
    });

    await runSyncRound(
      scriptedSync([
        {
          user: {
            mutations: [{ id: id as string, status: "applied" }],
            Preference: delta({
              created: [
                {
                  id: "user-1",
                  autoAdvanceEnabled: false,
                  autoAdvanceDirection: "newer",
                  undoSendDelaySeconds: 10,
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              ],
              newState: "pref-1",
            }),
          },
          mailAccounts: {},
        },
      ]).post,
    );

    expect(await listQueuedUserMutations()).toEqual([]);
    expect(await readPreference()).toMatchObject({ autoAdvanceEnabled: false });
  });

  it("survives offline: a request that never gets a response leaves the queue untouched", async () => {
    const id = await enqueueUserMutation({
      type: "setAutoAdvance",
      enabled: false,
      direction: "newer",
    });

    const offline = () => Promise.reject(new Error("network error"));
    await expect(runSyncRound(offline)).rejects.toThrow("network error");

    expect((await listQueuedUserMutations()).map((mutation) => mutation.id)).toEqual([id]);

    await runSyncRound(
      scriptedSync([
        { user: { mutations: [{ id: id as string, status: "applied" }] }, mailAccounts: {} },
      ]).post,
    );
    expect(await listQueuedUserMutations()).toEqual([]);
  });
});

describe("runSyncRound — Composition autosave flush (#45, ADR-0014)", () => {
  it("sends a coalesced save on the round's first request only", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    await saveComposition("comp-1", "acct-1", { ...EMPTY_COMPOSE_CONTENT, subject: "v1" });
    await saveComposition("comp-1", "acct-1", { ...EMPTY_COMPOSE_CONTENT, subject: "v2" });

    const { post, requests } = scriptedSync([{ user: {}, mailAccounts: {} }]);
    await runSyncRound(post);

    expect(requests).toHaveLength(1);
    const sent = requests[0]?.mailAccounts?.["acct-1"]?.composeSaves;
    expect(sent).toHaveLength(1);
    expect(sent?.[0]?.subject).toBe("v2"); // coalesced — never one save per keystroke
    expect(sent?.[0]?.id).toBe("comp-1");
  });

  it("dequeues on `applied` — draining exactly once, never resent on the next round", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    await saveComposition("comp-1", "acct-1", { ...EMPTY_COMPOSE_CONTENT, subject: "v1" });
    const [queued] = await listQueuedComposeSaves("acct-1");
    expect(queued).toBeDefined();
    const queuedSaveId = (queued as { saveId: string }).saveId;

    await runSyncRound(
      scriptedSync([
        {
          user: {},
          mailAccounts: {
            "acct-1": {
              composeSaves: [{ id: "comp-1", saveId: queuedSaveId, status: "applied", version: 1 }],
            },
          },
        },
      ]).post,
    );
    expect(await listQueuedComposeSaves("acct-1")).toEqual([]);
    expect((await localCache().compositions.get("comp-1"))?.version).toBe(1);

    const second = scriptedSync([{ user: {}, mailAccounts: {} }]);
    await runSyncRound(second.post);
    expect(second.requests[0]?.mailAccounts?.["acct-1"]?.composeSaves).toBeUndefined();
  });

  it("survives offline: a request that never gets a response leaves the queue untouched, still coalesced", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    await saveComposition("comp-1", "acct-1", {
      ...EMPTY_COMPOSE_CONTENT,
      subject: "typed while offline",
    });

    const failingPost = async (): Promise<SyncResponse> => {
      throw new Error("network unreachable");
    };
    await expect(runSyncRound(failingPost)).rejects.toThrow("network unreachable");

    const stillQueued = await listQueuedComposeSaves("acct-1");
    expect(stillQueued).toHaveLength(1);
    expect(stillQueued[0]?.subject).toBe("typed while offline");
  });

  it("survives a reload — closing and reopening the same cache — then syncs up on reconnect, coalesced not replayed", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    await saveComposition("comp-1", "acct-1", { ...EMPTY_COMPOSE_CONTENT, subject: "keystroke 1" });
    await saveComposition("comp-1", "acct-1", { ...EMPTY_COMPOSE_CONTENT, subject: "keystroke 2" });
    await saveComposition("comp-1", "acct-1", { ...EMPTY_COMPOSE_CONTENT, subject: "final text" });

    // A page reload: the same IndexedDB database reopens at the same schema
    // version — nothing wipes, and both the durable row and the coalesced
    // queue are right there, exactly as ADR-0014 requires.
    localCache().close();
    expect(await openLocalCache({ name: cacheName, schemaVersion: 1 })).toEqual({
      status: "current",
    });
    expect((await localCache().compositions.get("comp-1"))?.subject).toBe("final text");
    const reloaded = await listQueuedComposeSaves("acct-1");
    expect(reloaded).toHaveLength(1); // one coalesced save, not three replayed ones
    expect(reloaded[0]?.subject).toBe("final text");
    const reloadedSaveId = (reloaded[0] as { saveId: string }).saveId;

    const { post, requests } = scriptedSync([
      {
        user: {},
        mailAccounts: {
          "acct-1": {
            composeSaves: [{ id: "comp-1", saveId: reloadedSaveId, status: "applied", version: 1 }],
          },
        },
      },
    ]);
    await runSyncRound(post);

    expect(requests[0]?.mailAccounts?.["acct-1"]?.composeSaves).toHaveLength(1);
    expect(await listQueuedComposeSaves("acct-1")).toEqual([]);
  });

  it("never sends a Needs Reauth account's queue, while a co-queued active account still flushes", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1", { status: "needs_reauth" }));
    await localCache().mailAccounts.put(makeMailAccount("acct-2"));
    await saveComposition("comp-1", "acct-1", { ...EMPTY_COMPOSE_CONTENT, subject: "held" });
    await saveComposition("comp-2", "acct-2", { ...EMPTY_COMPOSE_CONTENT, subject: "flows" });

    const { post, requests } = scriptedSync([{ user: {}, mailAccounts: {} }]);
    await runSyncRound(post);

    const request = requests[0];
    expect(request?.mailAccounts?.["acct-1"]?.composeSaves).toBeUndefined();
    expect(request?.mailAccounts?.["acct-2"]?.composeSaves).toHaveLength(1);
    expect(await listQueuedComposeSaves("acct-1")).toHaveLength(1); // held, not dropped
  });

  describe("the app-icon badge (#53, ADR-0015)", () => {
    let setAppBadge: ReturnType<typeof vi.fn>;
    let clearAppBadge: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      setAppBadge = vi.fn().mockResolvedValue(undefined);
      clearAppBadge = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(globalThis, "Notification", {
        configurable: true,
        value: { permission: "granted" },
      });
      Object.defineProperty(globalThis.navigator, "setAppBadge", {
        configurable: true,
        value: setAppBadge,
      });
      Object.defineProperty(globalThis.navigator, "clearAppBadge", {
        configurable: true,
        value: clearAppBadge,
      });
    });

    // "The leader tab sets [the badge] while open" (ADR-0015) — a round
    // whose response carries `unreadInboxCount` snaps the badge to it,
    // covering both "read while open" (the count just went down) and
    // "reopen after a quiet gap" (a visibility-change round is an ordinary
    // round from `runSyncRound`'s own point of view — same code path).
    it("snaps the badge to the response's unreadInboxCount", async () => {
      const { post } = scriptedSync([{ user: { unreadInboxCount: 3 }, mailAccounts: {} }]);
      await runSyncRound(post);
      expect(setAppBadge).toHaveBeenCalledWith(3);
      expect(clearAppBadge).not.toHaveBeenCalled();
    });

    it("clears the badge once nothing is unread", async () => {
      const { post } = scriptedSync([{ user: { unreadInboxCount: 0 }, mailAccounts: {} }]);
      await runSyncRound(post);
      expect(clearAppBadge).toHaveBeenCalled();
      expect(setAppBadge).not.toHaveBeenCalled();
    });

    it("never touches the Badging API on a denied device", async () => {
      Object.defineProperty(globalThis, "Notification", {
        configurable: true,
        value: { permission: "denied" },
      });
      const { post } = scriptedSync([{ user: { unreadInboxCount: 5 }, mailAccounts: {} }]);
      await runSyncRound(post);
      expect(setAppBadge).not.toHaveBeenCalled();
      expect(clearAppBadge).not.toHaveBeenCalled();
    });
  });
});
