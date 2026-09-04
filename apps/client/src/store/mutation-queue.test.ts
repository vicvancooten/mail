import type { MutationIntent } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "./local-cache.js";
import {
  enqueueMutation,
  listQueuedMutations,
  resolveMutationOutcomes,
  subscribeMutationRejections,
} from "./mutation-queue.js";

/** `enqueueMutation`'s wake-up (ADR-0011): a queued Optimistic Action rides the next round trip, not the next 30s tick. */
const requestSyncNow = vi.fn();
vi.mock("../sync/sync-loop.js", () => ({
  requestSyncNow: () => requestSyncNow(),
}));

const ACCOUNT = "acct-1";

/** Narrows to the Thread-shaped intents this suite queues — the Composition ones (#46) name no Thread. */
function threadIdOf(intent: MutationIntent): string | undefined {
  return "threadId" in intent ? intent.threadId : undefined;
}

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `mutation-queue-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  requestSyncNow.mockClear();
});

afterEach(async () => {
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("enqueueMutation", () => {
  it("queues an intent with a fresh id and the Thread it targets as the referenced set", async () => {
    const id = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      ACCOUNT,
    );
    expect(id).not.toBeNull();

    const queued = await listQueuedMutations(ACCOUNT);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      id,
      mailAccountId: ACCOUNT,
      referencedThreadIds: ["t1"],
      intent: { type: "setStarred", threadId: "t1", starred: true },
    });
  });

  it("wakes the sync loop once the row lands (ADR-0011: no waiting for the next poll)", async () => {
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, ACCOUNT);

    expect(requestSyncNow).toHaveBeenCalledTimes(1);
  });

  it("does not wake the sync loop when the action coalesces away instead of queuing", async () => {
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, ACCOUNT);
    requestSyncNow.mockClear();

    const secondId = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: false },
      ACCOUNT,
    );

    expect(secondId).toBeNull();
    expect(requestSyncNow).not.toHaveBeenCalled();
  });

  it("keeps strict FIFO order across two Mail Accounts' queues independently", async () => {
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, "acct-1");
    await enqueueMutation({ type: "setStarred", threadId: "t2", starred: true }, "acct-2");
    await enqueueMutation({ type: "setRead", threadId: "t3", read: false }, "acct-1");

    const acct1 = await listQueuedMutations("acct-1");
    expect(acct1.map((mutation) => threadIdOf(mutation.intent))).toEqual(["t1", "t3"]);
    const acct2 = await listQueuedMutations("acct-2");
    expect(acct2.map((mutation) => threadIdOf(mutation.intent))).toEqual(["t2"]);
  });

  it("drops both rows when the exact inverse is queued before it flushes (star, then unstar)", async () => {
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, ACCOUNT);
    const secondId = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: false },
      ACCOUNT,
    );

    expect(secondId).toBeNull();
    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
  });

  it("does not coalesce two same-direction actions — nothing cleverer than the trivial case", async () => {
    await enqueueMutation({ type: "setRead", threadId: "t1", read: true }, ACCOUNT);
    await enqueueMutation({ type: "setRead", threadId: "t1", read: true }, ACCOUNT);

    expect(await listQueuedMutations(ACCOUNT)).toHaveLength(2);
  });

  it("does not coalesce across different Threads even for the same intent type", async () => {
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, ACCOUNT);
    await enqueueMutation({ type: "setStarred", threadId: "t2", starred: false }, ACCOUNT);

    expect(await listQueuedMutations(ACCOUNT)).toHaveLength(2);
  });

  it("does not coalesce archive then trash on the same Thread — both leave the Inbox, neither is the other's inverse", async () => {
    await enqueueMutation({ type: "archive", threadId: "t1" }, ACCOUNT);
    await enqueueMutation({ type: "trash", threadId: "t1" }, ACCOUNT);
    await enqueueMutation({ type: "archive", threadId: "t1" }, ACCOUNT);

    expect(await listQueuedMutations(ACCOUNT)).toHaveLength(3);
  });

  it("cancels a still-queued archive when Undo's restoreToInbox is queued before it flushes (#95, ADR-0019)", async () => {
    await enqueueMutation({ type: "archive", threadId: "t1" }, ACCOUNT);
    const secondId = await enqueueMutation({ type: "restoreToInbox", threadId: "t1" }, ACCOUNT);

    expect(secondId).toBeNull();
    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
  });

  it("cancels a still-queued trash the same way, via the same shared inverse (#95, ADR-0019)", async () => {
    await enqueueMutation({ type: "trash", threadId: "t1" }, ACCOUNT);
    const secondId = await enqueueMutation({ type: "restoreToInbox", threadId: "t1" }, ACCOUNT);

    expect(secondId).toBeNull();
    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
  });

  it("does not coalesce two same-direction snooze actions", async () => {
    await enqueueMutation(
      { type: "snooze", threadId: "t1", until: "2026-06-02T08:00:00.000Z" },
      ACCOUNT,
    );
    await enqueueMutation(
      { type: "snooze", threadId: "t1", until: "2026-06-03T08:00:00.000Z" },
      ACCOUNT,
    );

    expect(await listQueuedMutations(ACCOUNT)).toHaveLength(2);
  });

  it("cancels a still-queued snooze when Undo's unsnooze is queued before it flushes (#95, ADR-0019)", async () => {
    await enqueueMutation(
      { type: "snooze", threadId: "t1", until: "2026-06-02T08:00:00.000Z" },
      ACCOUNT,
    );
    const secondId = await enqueueMutation({ type: "unsnooze", threadId: "t1" }, ACCOUNT);

    expect(secondId).toBeNull();
    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
  });

  it("does not cancel an unrelated Thread's archive when restoreToInbox targets a different one", async () => {
    await enqueueMutation({ type: "archive", threadId: "t1" }, ACCOUNT);
    await enqueueMutation({ type: "restoreToInbox", threadId: "t2" }, ACCOUNT);

    expect(await listQueuedMutations(ACCOUNT)).toHaveLength(2);
  });

  it("cancels a still-queued denySender/blockSender when Undo's unblockAndRestore is queued before it flushes (#95, ADR-0019)", async () => {
    await enqueueMutation(
      { type: "blockSender", sender: { scope: "address", value: "v@example.test" } },
      ACCOUNT,
    );
    const secondId = await enqueueMutation(
      {
        type: "unblockAndRestore",
        sender: { scope: "address", value: "V@Example.test" },
        threadIds: ["t1"],
      },
      ACCOUNT,
    );

    expect(secondId).toBeNull();
    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
  });

  it("cancels a still-queued denySender the same way (#95, ADR-0019)", async () => {
    await enqueueMutation(
      { type: "denySender", sender: { scope: "address", value: "v@example.test" } },
      ACCOUNT,
    );
    const secondId = await enqueueMutation(
      {
        type: "unblockAndRestore",
        sender: { scope: "address", value: "v@example.test" },
        threadIds: ["t1"],
      },
      ACCOUNT,
    );

    expect(secondId).toBeNull();
    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
  });

  it("cancels a still-queued Block-Alias decision the same way, keyed to the Alias rather than a sender (#103)", async () => {
    await enqueueMutation(
      { type: "blockSender", sender: { scope: "recipient", value: "sales@mycompany.test" } },
      ACCOUNT,
    );
    const secondId = await enqueueMutation(
      {
        type: "unblockAndRestore",
        sender: { scope: "recipient", value: "Sales@MyCompany.test" },
        threadIds: ["t1"],
      },
      ACCOUNT,
    );

    expect(secondId).toBeNull();
    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
  });

  it("never lets a Block-Alias decision cancel an address-scoped Block of the same value (#103)", async () => {
    await enqueueMutation(
      { type: "blockSender", sender: { scope: "address", value: "sales@mycompany.test" } },
      ACCOUNT,
    );
    const secondId = await enqueueMutation(
      {
        type: "unblockAndRestore",
        sender: { scope: "recipient", value: "sales@mycompany.test" },
        threadIds: ["t1"],
      },
      ACCOUNT,
    );

    // Different scopes are different buckets — the address Block is untouched.
    expect(secondId).not.toBeNull();
    expect((await listQueuedMutations(ACCOUNT)).map((m) => m.intent.type)).toEqual([
      "blockSender",
      "unblockAndRestore",
    ]);
  });

  it("exempts every Thread unblockAndRestore names, not just one, from eviction (#95)", async () => {
    const id = await enqueueMutation(
      {
        type: "unblockAndRestore",
        sender: { scope: "address", value: "v@example.test" },
        threadIds: ["t1", "t2"],
      },
      ACCOUNT,
    );

    const queued = await listQueuedMutations(ACCOUNT);
    expect(queued[0]).toMatchObject({ id, referencedThreadIds: ["t1", "t2"] });
  });

  it("re-queues after a star/unstar/star sequence, leaving exactly the last action", async () => {
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, ACCOUNT);
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: false }, ACCOUNT);
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, ACCOUNT);

    const queued = await listQueuedMutations(ACCOUNT);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.intent).toEqual({ type: "setStarred", threadId: "t1", starred: true });
  });

  it("drops both rows when setPinned's exact inverse is queued before it flushes (#43)", async () => {
    await enqueueMutation({ type: "setPinned", threadId: "t1", pinned: true }, ACCOUNT);
    const secondId = await enqueueMutation(
      { type: "setPinned", threadId: "t1", pinned: false },
      ACCOUNT,
    );

    expect(secondId).toBeNull();
    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
  });

  it("coalesces applyLabel then removeLabel of the same name on the same Thread away (#43)", async () => {
    await enqueueMutation({ type: "applyLabel", threadId: "t1", name: "Work" }, ACCOUNT);
    const secondId = await enqueueMutation(
      { type: "removeLabel", threadId: "t1", name: "Work" },
      ACCOUNT,
    );

    expect(secondId).toBeNull();
    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
  });

  it("coalesces regardless of incidental whitespace in the name (#43)", async () => {
    await enqueueMutation({ type: "applyLabel", threadId: "t1", name: "  Work  " }, ACCOUNT);
    const secondId = await enqueueMutation(
      { type: "removeLabel", threadId: "t1", name: "Work" },
      ACCOUNT,
    );

    expect(secondId).toBeNull();
    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
  });

  it("does not coalesce applyLabel of two different names on the same Thread", async () => {
    await enqueueMutation({ type: "applyLabel", threadId: "t1", name: "Work" }, ACCOUNT);
    await enqueueMutation({ type: "applyLabel", threadId: "t1", name: "Personal" }, ACCOUNT);

    expect(await listQueuedMutations(ACCOUNT)).toHaveLength(2);
  });

  it("does not coalesce the same Label name applied on two different Threads", async () => {
    await enqueueMutation({ type: "applyLabel", threadId: "t1", name: "Work" }, ACCOUNT);
    await enqueueMutation({ type: "removeLabel", threadId: "t2", name: "Work" }, ACCOUNT);

    expect(await listQueuedMutations(ACCOUNT)).toHaveLength(2);
  });
});

describe("resolveMutationOutcomes", () => {
  it("dequeues both applied and rejected outcomes", async () => {
    const appliedId = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      ACCOUNT,
    );
    const rejectedId = await enqueueMutation(
      { type: "setRead", threadId: "t2", read: true },
      ACCOUNT,
    );
    const queued = await listQueuedMutations(ACCOUNT);

    await resolveMutationOutcomes(ACCOUNT, queued, [
      { id: appliedId as string, status: "applied" },
      { id: rejectedId as string, status: "rejected", reason: "thread_not_found" },
    ]);

    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
  });

  it("notifies rejection listeners with the intent and reason before dequeuing", async () => {
    const id = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      ACCOUNT,
    );
    const queued = await listQueuedMutations(ACCOUNT);

    const seen: unknown[] = [];
    const unsubscribe = subscribeMutationRejections((rejection) => seen.push(rejection));
    await resolveMutationOutcomes(ACCOUNT, queued, [
      { id: id as string, status: "rejected", reason: "thread_not_found" },
    ]);
    unsubscribe();

    expect(seen).toEqual([
      {
        mailAccountId: ACCOUNT,
        intent: { type: "setStarred", threadId: "t1", starred: true },
        reason: "thread_not_found",
      },
    ]);
  });

  it("does not notify on an applied outcome", async () => {
    const id = await enqueueMutation(
      { type: "setStarred", threadId: "t1", starred: true },
      ACCOUNT,
    );
    const queued = await listQueuedMutations(ACCOUNT);

    const seen: unknown[] = [];
    const unsubscribe = subscribeMutationRejections((rejection) => seen.push(rejection));
    await resolveMutationOutcomes(ACCOUNT, queued, [{ id: id as string, status: "applied" }]);
    unsubscribe();

    expect(seen).toEqual([]);
  });
});
