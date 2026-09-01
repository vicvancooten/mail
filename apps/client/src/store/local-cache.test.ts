import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { makeThread } from "../test-support/mail-fixtures.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { threadSortKey } from "./thread-sort-key.js";

/**
 * Wipe-and-resync is the Local Cache's whole schema strategy (ADR-0009), and
 * its one absolute exception is the Optimistic Action queue. These are the
 * tests for both halves.
 */

let counter = 0;
const names: string[] = [];

function uniqueName(): string {
  const name = `local-cache-test-${counter++}`;
  names.push(name);
  return name;
}

afterEach(async () => {
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function seedThread(id: string): Promise<void> {
  const thread = makeThread(id, "acct-1");
  await localCache().threads.put({ ...thread, sortKey: threadSortKey(thread) });
}

async function queueMutation(threadIds: string[]): Promise<void> {
  await localCache().pendingMutations.put({
    id: "01JMUTATION",
    mailAccountId: "acct-1",
    createdAt: "2026-06-01T12:00:00.000Z",
    referencedThreadIds: threadIds,
    intent: { type: "setStarred", threadId: threadIds[0] ?? "unknown", starred: true },
  });
}

async function queueComposeSave(): Promise<void> {
  await localCache().pendingComposeSaves.put({
    compositionId: "comp-1",
    mailAccountId: "acct-1",
    saveId: "01JSAVE",
    subject: "unsent draft",
    document: { type: "doc", content: [{ type: "paragraph" }] },
    to: [],
    cc: [],
    bcc: [],
    queuedAt: "2026-06-01T12:00:00.000Z",
  });
}

describe("opening the Local Cache", () => {
  it("reports a first-ever open as fresh", async () => {
    expect(await openLocalCache({ name: uniqueName(), schemaVersion: 1 })).toEqual({
      status: "fresh",
    });
  });

  it("reopens an unchanged schema without touching the data", async () => {
    const name = uniqueName();
    await openLocalCache({ name, schemaVersion: 1 });
    await seedThread("t1");

    expect(await openLocalCache({ name, schemaVersion: 1 })).toEqual({ status: "current" });
    expect(await localCache().threads.count()).toBe(1);
  });

  it("wipes the cached mail and its state tokens on a schema bump", async () => {
    const name = uniqueName();
    await openLocalCache({ name, schemaVersion: 1 });
    await seedThread("t1");
    await localCache().syncState.put({ key: "account:acct-1:Thread", token: "state-1" });

    expect(await openLocalCache({ name, schemaVersion: 2 })).toEqual({ status: "wiped", from: 1 });
    expect(await localCache().threads.count()).toBe(0);
    expect(await localCache().syncState.count()).toBe(0);
  });

  it("never wipes over a non-empty Optimistic Action queue — it waits", async () => {
    const name = uniqueName();
    await openLocalCache({ name, schemaVersion: 1 });
    await seedThread("t1");
    await queueMutation(["t1"]);

    expect(await openLocalCache({ name, schemaVersion: 2 })).toEqual({
      status: "deferred",
      from: 1,
      pendingMutations: 1,
      pendingComposeSaves: 0,
    });
    // The old data stays, and stays readable: an unsent archive performed on
    // a train outranks the upgrade.
    expect(await localCache().threads.count()).toBe(1);
  });

  it("never wipes over a non-empty Composition autosave queue either (ADR-0014)", async () => {
    const name = uniqueName();
    await openLocalCache({ name, schemaVersion: 1 });
    await queueComposeSave();

    expect(await openLocalCache({ name, schemaVersion: 2 })).toEqual({
      status: "deferred",
      from: 1,
      pendingMutations: 0,
      pendingComposeSaves: 1,
    });
    expect(await localCache().pendingComposeSaves.count()).toBe(1);
  });

  it("performs the deferred wipe once the queue drains", async () => {
    const name = uniqueName();
    await openLocalCache({ name, schemaVersion: 1 });
    await seedThread("t1");
    await queueMutation(["t1"]);
    await openLocalCache({ name, schemaVersion: 2 });

    await localCache().pendingMutations.clear();

    expect(await openLocalCache({ name, schemaVersion: 2 })).toEqual({ status: "wiped", from: 1 });
    expect(await localCache().threads.count()).toBe(0);
  });

  it("wipes a cache written by a newer Client, the same as a bump", async () => {
    const name = uniqueName();
    await openLocalCache({ name, schemaVersion: 2 });
    await seedThread("t1");

    expect(await openLocalCache({ name, schemaVersion: 1 })).toEqual({ status: "wiped", from: 2 });
    expect(await localCache().threads.count()).toBe(0);
  });

  it("holds a rolled-back Client's cache too, rather than dropping unsent actions", async () => {
    const name = uniqueName();
    await openLocalCache({ name, schemaVersion: 2 });
    await seedThread("t1");
    await queueMutation(["t1"]);

    expect(await openLocalCache({ name, schemaVersion: 1 })).toEqual({
      status: "deferred",
      from: 2,
      pendingMutations: 1,
      pendingComposeSaves: 0,
    });
    expect(await localCache().threads.count()).toBe(1);
  });
});
