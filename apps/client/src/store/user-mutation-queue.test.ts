import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `user-mutation-queue-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("enqueueUserMutation", () => {
  it("queues an intent with a fresh id", async () => {
    const id = await enqueueUserMutation({ type: "setTheme", theme: "dark" });

    const queued = await listQueuedUserMutations();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ id, intent: { type: "setTheme", theme: "dark" } });
  });

  it("supersedes an earlier edit to the same field rather than queuing both", async () => {
    await enqueueUserMutation({ type: "setTheme", theme: "dark" });
    await enqueueUserMutation({ type: "setTheme", theme: "light" });

    const queued = await listQueuedUserMutations();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.intent).toEqual({ type: "setTheme", theme: "light" });
  });

  it("keeps edits to different fields as independent queued rows", async () => {
    await enqueueUserMutation({ type: "setTheme", theme: "dark" });
    await enqueueUserMutation({
      type: "setAutoAdvance",
      enabled: false,
      direction: "newer",
    });
    await enqueueUserMutation({ type: "setUndoSendDelay", undoSendDelaySeconds: 0 });

    expect(await listQueuedUserMutations()).toHaveLength(3);
  });

  it("preserves FIFO order across distinct fields", async () => {
    await enqueueUserMutation({ type: "setUndoSendDelay", undoSendDelaySeconds: 5 });
    await enqueueUserMutation({ type: "setTheme", theme: "dark" });

    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent.type)).toEqual([
      "setUndoSendDelay",
      "setTheme",
    ]);
  });
});

describe("resolveUserMutationOutcomes", () => {
  it("dequeues both applied and rejected outcomes", async () => {
    const themeId = await enqueueUserMutation({ type: "setTheme", theme: "dark" });
    const delayId = await enqueueUserMutation({
      type: "setUndoSendDelay",
      undoSendDelaySeconds: 0,
    });

    await resolveUserMutationOutcomes([
      { id: themeId, status: "applied" },
      { id: delayId, status: "rejected", reason: "user_not_found" },
    ]);

    expect(await listQueuedUserMutations()).toEqual([]);
  });
});
