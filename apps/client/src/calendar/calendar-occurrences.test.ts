import type { Event } from "@mail/shared";
import { describe, expect, it } from "vitest";
import {
  bucketEventsByDay,
  eventDayKeys,
  eventStart,
  minutesOfDay,
} from "./calendar-occurrences.js";

function makeTestEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "e1",
    calendarId: "cal-1",
    seriesId: "s1",
    originalStart: "2026-09-08T09:00:00.000Z",
    start: "2026-09-08T09:00:00.000Z",
    end: "2026-09-08T10:00:00.000Z",
    allDay: false,
    tzid: "UTC",
    floating: false,
    title: "Standup",
    location: null,
    status: "confirmed",
    transparency: "opaque",
    updatedAt: "2026-09-08T09:00:00.000Z",
    ...overrides,
  };
}

describe("calendar-occurrences (#231)", () => {
  it("a plain timed Event spans exactly its own day", () => {
    expect(eventDayKeys(makeTestEvent())).toEqual(["2026-09-08"]);
  });

  it("a single-day all-day Event's exclusive end never spans onto the next day", () => {
    const event = makeTestEvent({
      allDay: true,
      floating: true,
      start: "2026-09-08T00:00:00.000",
      end: "2026-09-09T00:00:00.000",
    });
    expect(eventDayKeys(event)).toEqual(["2026-09-08"]);
  });

  it("a multi-day all-day Event spans every day up to (not including) the exclusive end", () => {
    const event = makeTestEvent({
      allDay: true,
      floating: true,
      start: "2026-09-08T00:00:00.000",
      end: "2026-09-11T00:00:00.000",
    });
    expect(eventDayKeys(event)).toEqual(["2026-09-08", "2026-09-09", "2026-09-10"]);
  });

  it("a floating Event reads its wall-clock digits verbatim, never re-converted through a zone", () => {
    const event = makeTestEvent({
      floating: true,
      tzid: null,
      start: "2026-09-08T23:00:00.000",
      end: "2026-09-08T23:30:00.000",
    });
    expect(minutesOfDay(eventStart(event))).toBe(23 * 60);
  });

  it("bucketEventsByDay drops a cancelled Occurrence, sorts timed ones by start then title", () => {
    const early = makeTestEvent({ id: "e-early", start: "2026-09-08T08:00:00.000Z", title: "Zed" });
    const late = makeTestEvent({ id: "e-late", start: "2026-09-08T09:00:00.000Z", title: "Alpha" });
    const cancelled = makeTestEvent({ id: "e-cancelled", status: "cancelled" });

    const buckets = bucketEventsByDay([late, early, cancelled]);
    const bucket = buckets.get("2026-09-08");
    expect(bucket?.timed.map((event) => event.id)).toEqual(["e-early", "e-late"]);
  });

  it("a real-instant Event reads its hour in the Home Time Zone, not the device's own (#303)", () => {
    // 2026-09-08T23:30:00Z is already Sep 9 at 08:30 in Tokyo.
    const event = makeTestEvent({ start: "2026-09-08T23:30:00.000Z" });
    const tokyo = eventStart(event, "Asia/Tokyo");
    expect(tokyo).toEqual({ year: 2026, month: 9, day: 9, hour: 8, minute: 30 });
  });

  it("bucketEventsByDay files an all-day Occurrence separately from timed ones", () => {
    const allDay = makeTestEvent({
      id: "e-allday",
      allDay: true,
      floating: true,
      start: "2026-09-08T00:00:00.000",
      end: "2026-09-09T00:00:00.000",
    });
    const timed = makeTestEvent({ id: "e-timed" });

    const buckets = bucketEventsByDay([allDay, timed]);
    const bucket = buckets.get("2026-09-08");
    expect(bucket?.allDay.map((event) => event.id)).toEqual(["e-allday"]);
    expect(bucket?.timed.map((event) => event.id)).toEqual(["e-timed"]);
  });
});
