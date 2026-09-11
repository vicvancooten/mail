import { cleanup, renderHook, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventDelta, makeEvent } from "../test-support/mail-fixtures.js";
import { jsonResponse } from "../test-support/mock-fetch.js";
import { useEventsForRange } from "./events.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { applyEventDelta } from "./server-writes.js";

/**
 * `useEventsForRange` (#232): a range fully inside `db.eventWindows` is the
 * Local Cache alone, no fetch; a range that reaches outside it fetches
 * `GET /calendars/events` for exactly the outside piece and merges the
 * result in, without ever writing it to the Local Cache — `store/events.ts`'s
 * own doc comment for why.
 */

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `events-range-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localCache().close();
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

describe("useEventsForRange", () => {
  it("a range fully inside the Event Window reads only the Local Cache, with no fetch", async () => {
    await applyEventDelta(
      eventDelta({
        created: [makeEvent("e1", "cal-1", { start: "2026-04-01T09:00:00.000Z" })],
        windowStart: "2026-03-01T00:00:00.000Z",
        windowEnd: "2027-06-01T00:00:00.000Z",
      }),
      { replace: false },
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() =>
      useEventsForRange("2026-04-01T00:00:00.000Z", "2026-04-02T00:00:00.000Z"),
    );

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.outsideWindow).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a range reaching before the window fetches only the outside piece and merges it in", async () => {
    await applyEventDelta(
      eventDelta({
        created: [makeEvent("e1", "cal-1", { start: "2026-04-01T09:00:00.000Z" })],
        windowStart: "2026-03-01T00:00:00.000Z",
        windowEnd: "2027-06-01T00:00:00.000Z",
      }),
      { replace: false },
    );
    const fetched = makeEvent("e-old", "cal-1", { start: "2026-01-15T09:00:00.000Z" });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        expect(url).toContain("/calendars/events?");
        expect(url).toContain("start=2026-01-01T00%3A00%3A00.000Z");
        expect(url).toContain("end=2026-03-01T00%3A00%3A00.000Z");
        return Promise.resolve(
          jsonResponse({
            events: [fetched],
            windowStart: "2026-03-01T00:00:00.000Z",
            windowEnd: "2027-06-01T00:00:00.000Z",
          }),
        );
      }),
    );

    const { result } = renderHook(() =>
      useEventsForRange("2026-01-01T00:00:00.000Z", "2026-04-02T00:00:00.000Z"),
    );

    await waitFor(() => expect(result.current.outsideWindow).toBe(true));
    await waitFor(() =>
      expect(result.current.events.map((event) => event.id).sort()).toEqual(["e-old", "e1"]),
    );
  });

  it("navigating back inside the window returns to the Local Cache alone, immediately", async () => {
    await applyEventDelta(
      eventDelta({
        created: [makeEvent("e1", "cal-1", { start: "2026-04-01T09:00:00.000Z" })],
        windowStart: "2026-03-01T00:00:00.000Z",
        windowEnd: "2027-06-01T00:00:00.000Z",
      }),
      { replace: false },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            events: [],
            windowStart: "2026-03-01T00:00:00.000Z",
            windowEnd: "2027-06-01T00:00:00.000Z",
          }),
        ),
      ),
    );

    const { result, rerender } = renderHook(
      ({ start, end }: { start: string; end: string }) => useEventsForRange(start, end),
      { initialProps: { start: "2026-01-01T00:00:00.000Z", end: "2026-04-02T00:00:00.000Z" } },
    );
    await waitFor(() => expect(result.current.outsideWindow).toBe(true));

    rerender({ start: "2026-04-01T00:00:00.000Z", end: "2026-04-02T00:00:00.000Z" });

    expect(result.current.outsideWindow).toBe(false);
    expect(result.current.events.map((event) => event.id)).toEqual(["e1"]);
  });
});
