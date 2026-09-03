import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "./local-cache.js";
import {
  enqueueUserMutation,
  listQueuedUserMutations,
  resolveUserMutationOutcomes,
} from "./user-mutation-queue.js";

/**
 * The User-scoped Optimistic Action queue (#54) — `mutation-queue.test.ts`'s
 * sibling. Coalescing is simpler here than the per-Thread queue's: every
 * `UserMutationIntent` is an absolute set on one `Preference` field, so a
 * second edit to the same field supersedes the first outright rather than
 * queuing alongside it.
 */

/** `enqueueUserMutation`'s wake-up (ADR-0011): a queued Preference edit rides the next round trip, not the next 30s tick. */
const requestSyncNow = vi.fn();
vi.mock("../sync/sync-loop.js", () => ({
  requestSyncNow: () => requestSyncNow(),
}));

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `user-mutation-queue-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  requestSyncNow.mockClear();
});

afterEach(async () => {
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("enqueueUserMutation", () => {
  it("queues an intent with a fresh id", async () => {
    const id = await enqueueUserMutation({
      type: "setAutoAdvance",
      enabled: true,
      direction: "older",
    });

    const queued = await listQueuedUserMutations();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      id,
      intent: { type: "setAutoAdvance", enabled: true, direction: "older" },
    });
  });

  it("supersedes an earlier edit to the same field rather than queuing both", async () => {
    await enqueueUserMutation({ type: "setAutoAdvance", enabled: true, direction: "older" });
    await enqueueUserMutation({ type: "setAutoAdvance", enabled: false, direction: "newer" });

    const queued = await listQueuedUserMutations();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.intent).toEqual({
      type: "setAutoAdvance",
      enabled: false,
      direction: "newer",
    });
  });

  it("wakes the sync loop once the row lands (ADR-0011: no waiting for the next poll)", async () => {
    await enqueueUserMutation({ type: "setAutoAdvance", enabled: true, direction: "older" });

    expect(requestSyncNow).toHaveBeenCalledTimes(1);
  });

  it("wakes the sync loop even when the edit supersedes an earlier one, unlike the per-Thread queue's coalesced-away skip", async () => {
    await enqueueUserMutation({ type: "setAutoAdvance", enabled: true, direction: "older" });
    requestSyncNow.mockClear();

    await enqueueUserMutation({ type: "setAutoAdvance", enabled: false, direction: "newer" });

    expect(requestSyncNow).toHaveBeenCalledTimes(1);
  });

  it("keeps edits to different fields as independent queued rows", async () => {
    await enqueueUserMutation({ type: "setAutoAdvance", enabled: false, direction: "newer" });
    await enqueueUserMutation({ type: "setUndoSendDelay", undoSendDelaySeconds: 0 });

    expect(await listQueuedUserMutations()).toHaveLength(2);
  });

  it("preserves FIFO order across distinct fields", async () => {
    await enqueueUserMutation({ type: "setUndoSendDelay", undoSendDelaySeconds: 5 });
    await enqueueUserMutation({ type: "setAutoAdvance", enabled: false, direction: "newer" });

    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent.type)).toEqual([
      "setUndoSendDelay",
      "setAutoAdvance",
    ]);
  });
});

describe("resolveUserMutationOutcomes", () => {
  it("dequeues both applied and rejected outcomes", async () => {
    const advanceId = await enqueueUserMutation({
      type: "setAutoAdvance",
      enabled: false,
      direction: "newer",
    });
    const delayId = await enqueueUserMutation({
      type: "setUndoSendDelay",
      undoSendDelaySeconds: 0,
    });

    await resolveUserMutationOutcomes([
      { id: advanceId, status: "applied" },
      { id: delayId, status: "rejected", reason: "user_not_found" },
    ]);

    expect(await listQueuedUserMutations()).toEqual([]);
  });
});
