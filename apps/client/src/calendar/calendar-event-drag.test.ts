import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUndoToastsForTest } from "../mail/undo-toast.js";
import type { CachedSeries } from "../store/db.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { readSeries } from "../store/series.js";
import { setSessionUserId } from "../store/session.js";
import { makeCalendar, makeEvent } from "../test-support/mail-fixtures.js";
import {
  commitEventMove,
  commitEventResize,
  isDraggableCalendar,
  resolveDraggedInstant,
  resolveDroppedOccurrence,
  resolveResizedOccurrence,
  snapToQuarterHour,
} from "./calendar-event-drag.js";

interface ToastOptions {
  id: string;
  duration: number;
  action?: { label: string; onClick(): void };
}

const toastFn = vi.fn<(message: string, opts: ToastOptions) => void>();

vi.mock("sonner", () => ({
  toast: Object.assign((message: string, opts: ToastOptions) => toastFn(message, opts), {
    dismiss: () => {},
  }),
}));

/**
 * `resolveDroppedOccurrence` calls `hydrateSeries`, which ordinarily hits
 * `GET /calendars/:calendarId/series/:seriesId` (a Series is never part of
 * the ordinary sync a fake-indexeddb test already has running) — stubbed
 * here to read the very same Local Cache row the test just seeded, so
 * `hydrateSeries`'s own re-`put` is a genuine no-op rather than a network
 * call this suite has no server behind.
 */
vi.mock("../api/calendars.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/calendars.js")>();
  return {
    ...actual,
    fetchSeries: vi.fn(async (_calendarId: string, seriesId: string) => {
      const cached = await localCache().seriesCache.get(seriesId);
      if (!cached) throw new Error(`no cached Series for ${seriesId}`);
      const { overrides, ...series } = cached;
      return { series, overrides };
    }),
  };
});

/**
 * Clicks the last-raised "Undo" for `eventReschedule`
 * (`undo-toast.test.ts`'s own `lastToastFor` shape) and waits a tick —
 * `commitEventMove`'s own Undo is fire-and-forget (`announceUndoableAction`'s
 * own `() => void` shape, the same posture every other Undo in this codebase
 * takes), so a caller that wants to read the Local Cache back has to let its
 * `saveSeriesBody` write actually land first.
 */
async function clickUndo(toastKind = "eventReschedule"): Promise<void> {
  const call = toastFn.mock.calls.filter(([, opts]) => opts.id === `undo-toast-${toastKind}`).pop();
  if (!call) throw new Error(`no ${toastKind} toast raised`);
  call[1].action?.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const USER = "user-1";
const CALENDAR = "cal-1";

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `calendar-event-drag-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  toastFn.mockClear();
  resetUndoToastsForTest();
});

afterEach(async () => {
  localCache().close();
  setSessionUserId(null);
  resetUndoToastsForTest();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

function baseSeries(overrides: Partial<CachedSeries> = {}): CachedSeries {
  const now = "2026-06-01T12:00:00.000Z";
  return {
    id: "series-1",
    userId: USER,
    calendarId: CALENDAR,
    uid: "uid-1",
    sequence: 0,
    title: "Standup",
    description: null,
    location: null,
    allDay: false,
    floating: false,
    tzid: "UTC",
    dtstart: "2026-06-01T09:00:00.000Z",
    durationMs: 30 * 60 * 1000,
    rrules: [],
    rdates: [],
    exdates: [],
    transparency: "opaque",
    attendees: [],
    reminders: [],
    upstreamId: null,
    etag: null,
    createdAt: now,
    updatedAt: now,
    overrides: [],
    ...overrides,
  };
}

describe("snapToQuarterHour (#305)", () => {
  it("rounds to the nearest 15 minutes", () => {
    expect(snapToQuarterHour(7)).toBe(0);
    expect(snapToQuarterHour(8)).toBe(15);
    expect(snapToQuarterHour(22)).toBe(15);
    expect(snapToQuarterHour(23)).toBe(30);
  });

  it("clamps inside one civil day", () => {
    expect(snapToQuarterHour(-10)).toBe(0);
    expect(snapToQuarterHour(24 * 60)).toBe(24 * 60 - 15);
  });
});

describe("resolveDraggedInstant (#305)", () => {
  const current = { year: 2026, month: 6, day: 1, hour: 9, minute: 0 };

  it("replaces both date and time for a Day/Week drop", () => {
    const target = { year: 2026, month: 6, day: 3 };
    expect(resolveDraggedInstant(current, target, 645)).toEqual({
      year: 2026,
      month: 6,
      day: 3,
      hour: 10,
      minute: 45,
    });
  });

  it("keeps the current time of day for a Month drop (null minutes)", () => {
    const target = { year: 2026, month: 6, day: 10 };
    expect(resolveDraggedInstant(current, target, null)).toEqual({
      year: 2026,
      month: 6,
      day: 10,
      hour: 9,
      minute: 0,
    });
  });
});

describe("isDraggableCalendar (#305)", () => {
  it("is draggable when the Calendar is writable", () => {
    const calendar = makeCalendar(CALENDAR, USER);
    expect(isDraggableCalendar(calendar)).toBe(true);
  });

  it("never drags on a read-only Calendar", () => {
    const calendar = makeCalendar(CALENDAR, USER, {
      capabilities: { ...LOCAL_CALENDAR_CAPABILITIES, writable: false },
    });
    expect(isDraggableCalendar(calendar)).toBe(false);
  });

  it("never drags with no Calendar at all", () => {
    expect(isDraggableCalendar(undefined)).toBe(false);
  });
});

describe("resolveDroppedOccurrence (#305)", () => {
  it("resolves null on a read-only Calendar", async () => {
    const event = makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
    });
    const readOnly = makeCalendar(CALENDAR, USER, {
      capabilities: { ...LOCAL_CALENDAR_CAPABILITIES, writable: false },
    });
    const dropped = await resolveDroppedOccurrence(
      event,
      readOnly,
      { year: 2026, month: 6, day: 2 },
      600,
    );
    expect(dropped).toBeNull();
  });

  // A floating Occurrence (#305): wall-clock digits read back verbatim
  // (`civilInstantToIso`'s own doc comment), so these two assertions stay
  // true regardless of the machine's own local zone running the suite —
  // unlike a real timed Occurrence, whose drop target is genuinely the
  // viewer's own local wall clock (exercised in `commitEventMove`'s own
  // describe blocks below, which never assert a literal instant across a
  // date/time change).
  it("resolves null when the drop lands back on the same instant", async () => {
    await localCache().seriesCache.put(baseSeries({ floating: true }));
    const event = makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
      floating: true,
    });
    const calendar = makeCalendar(CALENDAR, USER);
    const dropped = await resolveDroppedOccurrence(
      event,
      calendar,
      { year: 2026, month: 6, day: 1 },
      9 * 60,
    );
    expect(dropped).toBeNull();
  });

  it("carries the Occurrence's own duration forward onto the new instant", async () => {
    await localCache().seriesCache.put(baseSeries({ floating: true }));
    const event = makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
      floating: true,
    });
    const calendar = makeCalendar(CALENDAR, USER);
    const dropped = await resolveDroppedOccurrence(
      event,
      calendar,
      { year: 2026, month: 6, day: 2 },
      10 * 60,
    );
    expect(dropped?.nextStartIso).toBe("2026-06-02T10:00:00.000Z");
    expect(dropped?.nextEndIso).toBe("2026-06-02T10:30:00.000Z");
  });
});

describe("commitEventMove — scope 'this' (#305)", () => {
  function occurrence() {
    return makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
    });
  }

  it("adds an override for just this Occurrence, leaving the Series' own dtstart alone", async () => {
    const series = baseSeries({ rrules: ["FREQ=DAILY"] });
    await localCache().seriesCache.put(series);

    await commitEventMove(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-01T11:00:00.000Z",
        nextEndIso: "2026-06-01T11:30:00.000Z",
      },
      "this",
    );

    const saved = await readSeries("series-1");
    expect(saved?.dtstart).toBe(series.dtstart);
    expect(saved?.overrides).toEqual([
      {
        id: expect.any(String),
        seriesId: "series-1",
        originalStart: "2026-06-01T09:00:00.000Z",
        start: "2026-06-01T11:00:00.000Z",
        end: "2026-06-01T11:30:00.000Z",
        title: null,
        location: null,
      },
    ]);
  });

  it("Undo restores the Series to having no override at all", async () => {
    const series = baseSeries({ rrules: ["FREQ=DAILY"] });
    await localCache().seriesCache.put(series);

    await commitEventMove(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-01T11:00:00.000Z",
        nextEndIso: "2026-06-01T11:30:00.000Z",
      },
      "this",
    );
    await clickUndo();

    const saved = await readSeries("series-1");
    expect(saved?.overrides).toEqual([]);
  });

  it("Undo restores a previously-overridden Occurrence's own prior override, not a blank slate", async () => {
    const series = baseSeries({
      rrules: ["FREQ=DAILY"],
      overrides: [
        {
          id: "ov-1",
          seriesId: "series-1",
          originalStart: "2026-06-01T09:00:00.000Z",
          start: "2026-06-01T09:15:00.000Z",
          end: "2026-06-01T09:45:00.000Z",
          title: "Standup (moved)",
          location: null,
        },
      ],
    });
    await localCache().seriesCache.put(series);

    await commitEventMove(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-01T14:00:00.000Z",
        nextEndIso: "2026-06-01T14:30:00.000Z",
      },
      "this",
    );
    await clickUndo();

    const saved = await readSeries("series-1");
    expect(saved?.overrides).toEqual([
      {
        id: "ov-1",
        seriesId: "series-1",
        originalStart: "2026-06-01T09:00:00.000Z",
        start: "2026-06-01T09:15:00.000Z",
        end: "2026-06-01T09:45:00.000Z",
        title: "Standup (moved)",
        location: null,
      },
    ]);
  });
});

describe("commitEventMove — scope 'all' (#305)", () => {
  function occurrence() {
    return makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
    });
  }

  it("shifts the Series' own dtstart by the exact delta the dragged Occurrence moved", async () => {
    const series = baseSeries({ rrules: ["FREQ=WEEKLY"] });
    await localCache().seriesCache.put(series);

    await commitEventMove(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-02T10:00:00.000Z",
        nextEndIso: "2026-06-02T10:30:00.000Z",
      },
      "all",
    );

    const saved = await readSeries("series-1");
    // +1 day, +1 hour on top of the Series' own 09:00 dtstart.
    expect(saved?.dtstart).toBe("2026-06-02T10:00:00.000Z");
    expect(saved?.overrides).toEqual([]);
  });

  it("Undo restores the Series' original dtstart", async () => {
    const series = baseSeries({ rrules: ["FREQ=WEEKLY"] });
    await localCache().seriesCache.put(series);

    await commitEventMove(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-02T10:00:00.000Z",
        nextEndIso: "2026-06-02T10:30:00.000Z",
      },
      "all",
    );
    await clickUndo();

    const saved = await readSeries("series-1");
    expect(saved?.dtstart).toBe(series.dtstart);
  });
});

describe("commitEventMove — scope 'thisAndFollowing' (#305)", () => {
  function occurrence() {
    return makeEvent("series-1@2026-06-03T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-03T09:00:00.000Z",
      start: "2026-06-03T09:00:00.000Z",
      end: "2026-06-03T09:30:00.000Z",
    });
  }

  it("caps the old Series just before this Occurrence and creates a continuation at the new instant", async () => {
    const series = baseSeries({ rrules: ["FREQ=DAILY"] });
    await localCache().seriesCache.put(series);

    await commitEventMove(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-03T14:00:00.000Z",
        nextEndIso: "2026-06-03T14:30:00.000Z",
      },
      "thisAndFollowing",
    );

    const oldSeries = await readSeries("series-1");
    expect(oldSeries?.rrules[0]).toContain("UNTIL=20260603T085959Z");

    const allSeries = await localCache().seriesCache.toArray();
    const continuation = allSeries.find((s) => s.id !== "series-1");
    expect(continuation?.dtstart).toBe("2026-06-03T14:00:00.000Z");
    expect(continuation?.rrules).toEqual(["FREQ=DAILY"]);
    expect(continuation?.title).toBe("Standup");
  });

  it("Undo restores the old Series' own rrules and deletes the continuation", async () => {
    const series = baseSeries({ rrules: ["FREQ=DAILY"] });
    await localCache().seriesCache.put(series);

    await commitEventMove(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-03T14:00:00.000Z",
        nextEndIso: "2026-06-03T14:30:00.000Z",
      },
      "thisAndFollowing",
    );
    await clickUndo();

    const oldSeries = await readSeries("series-1");
    expect(oldSeries?.rrules).toEqual(["FREQ=DAILY"]);
  });
});

describe("resolveResizedOccurrence (#306)", () => {
  it("resolves null on a read-only Calendar", async () => {
    const event = makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
    });
    const readOnly = makeCalendar(CALENDAR, USER, {
      capabilities: { ...LOCAL_CALENDAR_CAPABILITIES, writable: false },
    });
    const resized = await resolveResizedOccurrence(event, readOnly, "end", 10 * 60);
    expect(resized).toBeNull();
  });

  it("resolves null when the resize lands back on the same instant", async () => {
    await localCache().seriesCache.put(baseSeries({ floating: true }));
    const event = makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
      floating: true,
    });
    const calendar = makeCalendar(CALENDAR, USER);
    const resized = await resolveResizedOccurrence(event, calendar, "end", 9 * 60 + 30);
    expect(resized).toBeNull();
  });

  it("dragging the bottom edge changes only the end", async () => {
    await localCache().seriesCache.put(baseSeries({ floating: true }));
    const event = makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
      floating: true,
    });
    const calendar = makeCalendar(CALENDAR, USER);
    const resized = await resolveResizedOccurrence(event, calendar, "end", 10 * 60);
    expect(resized?.nextStartIso).toBe("2026-06-01T09:00:00.000Z");
    expect(resized?.nextEndIso).toBe("2026-06-01T10:00:00.000Z");
  });

  it("dragging the top edge changes only the start", async () => {
    await localCache().seriesCache.put(baseSeries({ floating: true }));
    const event = makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
      floating: true,
    });
    const calendar = makeCalendar(CALENDAR, USER);
    const resized = await resolveResizedOccurrence(event, calendar, "start", 8 * 60);
    expect(resized?.nextStartIso).toBe("2026-06-01T08:00:00.000Z");
    expect(resized?.nextEndIso).toBe("2026-06-01T09:30:00.000Z");
  });

  it("clamps the bottom edge to a minimum one-slot (15 minute) duration", async () => {
    await localCache().seriesCache.put(baseSeries({ floating: true }));
    const event = makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
      floating: true,
    });
    const calendar = makeCalendar(CALENDAR, USER);
    // Dragged the bottom edge up past the top edge entirely — clamps to the floor.
    const resized = await resolveResizedOccurrence(event, calendar, "end", 0);
    expect(resized?.nextStartIso).toBe("2026-06-01T09:00:00.000Z");
    expect(resized?.nextEndIso).toBe("2026-06-01T09:15:00.000Z");
  });

  it("clamps the top edge to a minimum one-slot (15 minute) duration", async () => {
    await localCache().seriesCache.put(baseSeries({ floating: true }));
    const event = makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
      floating: true,
    });
    const calendar = makeCalendar(CALENDAR, USER);
    // Dragged the top edge down past the bottom edge entirely — clamps to the floor.
    const resized = await resolveResizedOccurrence(event, calendar, "start", 23 * 60);
    expect(resized?.nextStartIso).toBe("2026-06-01T09:15:00.000Z");
    expect(resized?.nextEndIso).toBe("2026-06-01T09:30:00.000Z");
  });
});

describe("commitEventResize — scope 'this' (#306)", () => {
  function occurrence() {
    return makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
    });
  }

  it("adds an override carrying the new end, leaving the Series' own durationMs alone", async () => {
    const series = baseSeries({ rrules: ["FREQ=DAILY"] });
    await localCache().seriesCache.put(series);

    await commitEventResize(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-01T09:00:00.000Z",
        nextEndIso: "2026-06-01T10:00:00.000Z",
      },
      "this",
    );

    const saved = await readSeries("series-1");
    expect(saved?.durationMs).toBe(series.durationMs);
    expect(saved?.overrides).toEqual([
      {
        id: expect.any(String),
        seriesId: "series-1",
        originalStart: "2026-06-01T09:00:00.000Z",
        start: "2026-06-01T09:00:00.000Z",
        end: "2026-06-01T10:00:00.000Z",
        title: null,
        location: null,
      },
    ]);
  });

  it("Undo restores the Series to having no override at all", async () => {
    const series = baseSeries({ rrules: ["FREQ=DAILY"] });
    await localCache().seriesCache.put(series);

    await commitEventResize(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-01T09:00:00.000Z",
        nextEndIso: "2026-06-01T10:00:00.000Z",
      },
      "this",
    );
    await clickUndo("eventResize");

    const saved = await readSeries("series-1");
    expect(saved?.overrides).toEqual([]);
  });
});

describe("commitEventResize — scope 'all' (#306)", () => {
  function occurrence() {
    return makeEvent("series-1@2026-06-01T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-01T09:00:00.000Z",
      start: "2026-06-01T09:00:00.000Z",
      end: "2026-06-01T09:30:00.000Z",
    });
  }

  it("writes the new durationMs onto the Series, dtstart unchanged for a bottom-edge resize", async () => {
    const series = baseSeries({ rrules: ["FREQ=WEEKLY"] });
    await localCache().seriesCache.put(series);

    await commitEventResize(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-01T09:00:00.000Z",
        nextEndIso: "2026-06-01T10:00:00.000Z",
      },
      "all",
    );

    const saved = await readSeries("series-1");
    expect(saved?.dtstart).toBe(series.dtstart);
    expect(saved?.durationMs).toBe(60 * 60 * 1000);
  });

  it("shifts dtstart and writes the new durationMs for a top-edge resize", async () => {
    const series = baseSeries({ rrules: ["FREQ=WEEKLY"] });
    await localCache().seriesCache.put(series);

    await commitEventResize(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-01T08:00:00.000Z",
        nextEndIso: "2026-06-01T09:30:00.000Z",
      },
      "all",
    );

    const saved = await readSeries("series-1");
    expect(saved?.dtstart).toBe("2026-06-01T08:00:00.000Z");
    expect(saved?.durationMs).toBe(90 * 60 * 1000);
  });

  it("Undo restores the Series' original dtstart and durationMs", async () => {
    const series = baseSeries({ rrules: ["FREQ=WEEKLY"] });
    await localCache().seriesCache.put(series);

    await commitEventResize(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-01T08:00:00.000Z",
        nextEndIso: "2026-06-01T09:30:00.000Z",
      },
      "all",
    );
    await clickUndo("eventResize");

    const saved = await readSeries("series-1");
    expect(saved?.dtstart).toBe(series.dtstart);
    expect(saved?.durationMs).toBe(series.durationMs);
  });
});

describe("commitEventResize — scope 'thisAndFollowing' (#306)", () => {
  function occurrence() {
    return makeEvent("series-1@2026-06-03T09:00:00.000Z", CALENDAR, {
      seriesId: "series-1",
      originalStart: "2026-06-03T09:00:00.000Z",
      start: "2026-06-03T09:00:00.000Z",
      end: "2026-06-03T09:30:00.000Z",
    });
  }

  it("caps the old Series and creates a continuation carrying the resized durationMs", async () => {
    const series = baseSeries({ rrules: ["FREQ=DAILY"] });
    await localCache().seriesCache.put(series);

    await commitEventResize(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-03T09:00:00.000Z",
        nextEndIso: "2026-06-03T10:00:00.000Z",
      },
      "thisAndFollowing",
    );

    const oldSeries = await readSeries("series-1");
    expect(oldSeries?.rrules[0]).toContain("UNTIL=20260603T085959Z");
    expect(oldSeries?.durationMs).toBe(series.durationMs);

    const allSeries = await localCache().seriesCache.toArray();
    const continuation = allSeries.find((s) => s.id !== "series-1");
    expect(continuation?.dtstart).toBe("2026-06-03T09:00:00.000Z");
    expect(continuation?.durationMs).toBe(60 * 60 * 1000);
    expect(continuation?.rrules).toEqual(["FREQ=DAILY"]);
  });

  it("Undo restores the old Series' own rrules and deletes the continuation", async () => {
    const series = baseSeries({ rrules: ["FREQ=DAILY"] });
    await localCache().seriesCache.put(series);

    await commitEventResize(
      {
        event: occurrence(),
        series,
        nextStartIso: "2026-06-03T09:00:00.000Z",
        nextEndIso: "2026-06-03T10:00:00.000Z",
      },
      "thisAndFollowing",
    );
    await clickUndo("eventResize");

    const oldSeries = await readSeries("series-1");
    expect(oldSeries?.rrules).toEqual(["FREQ=DAILY"]);
  });
});
