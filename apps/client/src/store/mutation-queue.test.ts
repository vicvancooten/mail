import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localCache, openLocalCache } from "./local-cache.js";
import {
  enqueueMutation,
  listQueuedMutations,
  resolveMutationOutcomes,
  subscribeMutationRejections,
} from "./mutation-queue.js";

const ACCOUNT = "acct-1";
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `mutation-queue-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
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

  it("keeps strict FIFO order across two Mail Accounts' queues independently", async () => {
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, "acct-1");
    await enqueueMutation({ type: "setStarred", threadId: "t2", starred: true }, "acct-2");
    await enqueueMutation({ type: "setRead", threadId: "t3", read: false }, "acct-1");

    const acct1 = await listQueuedMutations("acct-1");
    expect(acct1.map((mutation) => mutation.intent.threadId)).toEqual(["t1", "t3"]);
    const acct2 = await listQueuedMutations("acct-2");
    expect(acct2.map((mutation) => mutation.intent.threadId)).toEqual(["t2"]);
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

  it("re-queues after a star/unstar/star sequence, leaving exactly the last action", async () => {
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, ACCOUNT);
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: false }, ACCOUNT);
    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, ACCOUNT);

    const queued = await listQueuedMutations(ACCOUNT);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.intent).toEqual({ type: "setStarred", threadId: "t1", starred: true });
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
