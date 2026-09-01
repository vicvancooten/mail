import type { SyncRequest, SyncResponse } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readThreadWindow } from "../store/index.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
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

  it("fetches nothing while a schema wipe waits on the Optimistic Action queue", async () => {
    await localCache().mailAccounts.put(makeMailAccount("acct-1"));
    await localCache().pendingMutations.put({
      id: "01JQUEUED",
      mailAccountId: "acct-1",
      createdAt: minutesAfterEpoch(0),
      referencedThreadIds: [],
    });
    await openLocalCache({ name: cacheName, schemaVersion: 2 });

    const { post, requests } = scriptedSync([]);
    const result = await runSyncRound(post);

    expect(result).toEqual({ deferred: true, pages: 0, changed: false });
    expect(requests).toHaveLength(0);
    expect(await localCache().mailAccounts.count()).toBe(1);
  });
});
