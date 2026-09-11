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

/** `expect(x).toBeDefined()` narrows in an `if`, not through the assertion itself — this does both in one line. */
function defined<T>(value: T | undefined | null): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as T;
}

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

  /**
   * A Series' structural intents (#233): genuine inverse pairs, unlike the
   * `Preference` fields above — a still-queued `createSeries` meeting its
   * own `deleteSeries` cancels both away, the same trick
   * `mutation-queue.test.ts`'s own `discardComposition`/`undiscardComposition`
   * coverage exercises for the per-Thread queue.
   */
  describe("Series structural intents (#233)", () => {
    it("cancels a still-queued createSeries against its own deleteSeries", async () => {
      const seriesId = "series-1";
      await enqueueUserMutation({ type: "createSeries", seriesId, calendarId: "cal-1" });

      const id = await enqueueUserMutation({ type: "deleteSeries", seriesId });

      expect(id).toBeNull();
      expect(await listQueuedUserMutations()).toHaveLength(0);
    });

    it("keeps trashSeries/restoreSeries in their own bucket, never cancelling an unrelated createSeries", async () => {
      const seriesId = "series-1";
      await enqueueUserMutation({ type: "createSeries", seriesId, calendarId: "cal-1" });

      const id = await enqueueUserMutation({ type: "trashSeries", seriesId });

      expect(id).not.toBeNull();
      expect(await listQueuedUserMutations()).toHaveLength(2);
    });

    it("keys addExdate/removeExdate on seriesId:exdate, so two different Occurrences stay independent", async () => {
      const seriesId = "series-1";
      await enqueueUserMutation({
        type: "addExdate",
        seriesId,
        exdate: "2026-01-05T09:00:00.000Z",
      });
      await enqueueUserMutation({
        type: "addExdate",
        seriesId,
        exdate: "2026-01-12T09:00:00.000Z",
      });

      expect(await listQueuedUserMutations()).toHaveLength(2);
    });

    it("cancels a still-queued addExdate against its own removeExdate for the same Occurrence", async () => {
      const seriesId = "series-1";
      const exdate = "2026-01-05T09:00:00.000Z";
      await enqueueUserMutation({ type: "addExdate", seriesId, exdate });

      const id = await enqueueUserMutation({ type: "removeExdate", seriesId, exdate });

      expect(id).toBeNull();
      expect(await listQueuedUserMutations()).toHaveLength(0);
    });
  });

  describe("Calendar settings sheet intents (#236)", () => {
    it("supersedes an earlier edit to the same Calendar's colour, but keeps a different Calendar's edit independent", async () => {
      await enqueueUserMutation({
        type: "setCalendarColor",
        calendarId: "cal-1",
        color: "#111111",
      });
      await enqueueUserMutation({
        type: "setCalendarColor",
        calendarId: "cal-1",
        color: "#222222",
      });
      await enqueueUserMutation({
        type: "setCalendarColor",
        calendarId: "cal-2",
        color: "#333333",
      });

      const queued = await listQueuedUserMutations();
      expect(queued).toHaveLength(2);
      expect(queued.map((mutation) => mutation.intent)).toEqual([
        { type: "setCalendarColor", calendarId: "cal-1", color: "#222222" },
        { type: "setCalendarColor", calendarId: "cal-2", color: "#333333" },
      ]);
    });

    it("keeps a Calendar's details/colour/default/mailAccount edits as independent queued rows", async () => {
      await enqueueUserMutation({
        type: "updateCalendarDetails",
        calendarId: "cal-1",
        name: "Work",
        description: null,
        timeZone: "UTC",
      });
      await enqueueUserMutation({
        type: "setCalendarColor",
        calendarId: "cal-1",
        color: "#111111",
      });
      await enqueueUserMutation({ type: "setDefaultCalendar", calendarId: "cal-1" });
      await enqueueUserMutation({
        type: "setCalendarMailAccount",
        calendarId: "cal-1",
        mailAccountId: "acct-1",
      });

      expect(await listQueuedUserMutations()).toHaveLength(4);
    });
  });
});

describe("resolveUserMutationOutcomes", () => {
  it("dequeues both applied and rejected outcomes", async () => {
    const advanceId = defined(
      await enqueueUserMutation({ type: "setAutoAdvance", enabled: false, direction: "newer" }),
    );
    const delayId = defined(
      await enqueueUserMutation({ type: "setUndoSendDelay", undoSendDelaySeconds: 0 }),
    );

    await resolveUserMutationOutcomes([
      { id: advanceId, status: "applied" },
      { id: delayId, status: "rejected", reason: "user_not_found" },
    ]);

    expect(await listQueuedUserMutations()).toEqual([]);
  });
});
