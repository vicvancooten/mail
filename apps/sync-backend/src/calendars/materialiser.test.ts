import { describe, expect, it } from "vitest";
import {
  type MaterialiserSeriesInput,
  materialiseSeries,
  type OverrideInput,
} from "./materialiser.js";

const BASE_SERIES: MaterialiserSeriesInput = {
  dtstart: new Date(Date.UTC(2026, 0, 5, 9, 0, 0)), // Monday 9am UTC
  durationMs: 60 * 60 * 1000, // 1 hour
  rrules: [],
  rdates: [],
  exdates: [],
  tzid: null,
  title: "Standup",
  location: null,
};

describe("materialiseSeries (#230)", () => {
  it("a non-recurring Series with no rule materialises exactly one Occurrence", () => {
    const occurrences = materialiseSeries(
      BASE_SERIES,
      new Map(),
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 1, 1)),
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      originalStart: BASE_SERIES.dtstart,
      start: BASE_SERIES.dtstart,
      end: new Date(Date.UTC(2026, 0, 5, 10, 0, 0)),
      title: "Standup",
      location: null,
    });
  });

  it("outside the window, a non-recurring Series materialises nothing", () => {
    const occurrences = materialiseSeries(
      BASE_SERIES,
      new Map(),
      new Date(Date.UTC(2027, 0, 1)),
      new Date(Date.UTC(2027, 1, 1)),
    );
    expect(occurrences).toHaveLength(0);
  });

  it("expands a weekly RRULE within the window, and never past the window edge", () => {
    const series: MaterialiserSeriesInput = { ...BASE_SERIES, rrules: ["FREQ=WEEKLY;BYDAY=MO"] };
    const occurrences = materialiseSeries(
      series,
      new Map(),
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 1, 1)), // Feb 1
    );
    // Mondays in Jan 2026 within [Jan 1, Feb 1]: 5, 12, 19, 26 — never Feb 2.
    expect(occurrences.map((o) => o.originalStart.toISOString())).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-01-12T09:00:00.000Z",
      "2026-01-19T09:00:00.000Z",
      "2026-01-26T09:00:00.000Z",
    ]);
  });

  it("a cancelled Occurrence is an exdate and nothing more — it never appears, no Override needed", () => {
    const series: MaterialiserSeriesInput = {
      ...BASE_SERIES,
      rrules: ["FREQ=WEEKLY;BYDAY=MO"],
      exdates: ["2026-01-12T09:00:00.000Z"],
    };
    const occurrences = materialiseSeries(
      series,
      new Map(),
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 1, 1)),
    );
    expect(occurrences.map((o) => o.originalStart.toISOString())).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-01-19T09:00:00.000Z",
      "2026-01-26T09:00:00.000Z",
    ]);
  });

  it("an Override moves one Occurrence's time, title and location, matched by its originalStart", () => {
    const series: MaterialiserSeriesInput = { ...BASE_SERIES, rrules: ["FREQ=WEEKLY;BYDAY=MO"] };
    const overrides = new Map<string, OverrideInput>([
      [
        "2026-01-12T09:00:00.000Z",
        {
          originalStart: new Date(Date.UTC(2026, 0, 12, 9, 0, 0)),
          start: new Date(Date.UTC(2026, 0, 12, 14, 0, 0)),
          end: new Date(Date.UTC(2026, 0, 12, 15, 0, 0)),
          title: "Standup (moved)",
          location: "Room 2",
        },
      ],
    ]);
    const occurrences = materialiseSeries(
      series,
      overrides,
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 1, 1)),
    );
    const moved = occurrences.find(
      (o) => o.originalStart.toISOString() === "2026-01-12T09:00:00.000Z",
    );
    expect(moved).toMatchObject({
      start: new Date(Date.UTC(2026, 0, 12, 14, 0, 0)),
      end: new Date(Date.UTC(2026, 0, 12, 15, 0, 0)),
      title: "Standup (moved)",
      location: "Room 2",
    });
    // Every other occurrence is untouched.
    const untouched = occurrences.find(
      (o) => o.originalStart.toISOString() === "2026-01-05T09:00:00.000Z",
    );
    expect(untouched).toMatchObject({ title: "Standup", location: null });
  });

  it("an Override with only a start set still inherits the Series' own title/location", () => {
    const series: MaterialiserSeriesInput = { ...BASE_SERIES, rrules: ["FREQ=WEEKLY;BYDAY=MO"] };
    const overrides = new Map<string, OverrideInput>([
      [
        "2026-01-12T09:00:00.000Z",
        {
          originalStart: new Date(Date.UTC(2026, 0, 12, 9, 0, 0)),
          start: new Date(Date.UTC(2026, 0, 12, 14, 0, 0)),
          end: null,
          title: null,
          location: null,
        },
      ],
    ]);
    const occurrences = materialiseSeries(
      series,
      overrides,
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 1, 1)),
    );
    const moved = occurrences.find(
      (o) => o.originalStart.toISOString() === "2026-01-12T09:00:00.000Z",
    );
    expect(moved).toMatchObject({
      start: new Date(Date.UTC(2026, 0, 12, 14, 0, 0)),
      // No override `end` given — falls back to the Series' own duration off the *original* start, not the moved one.
      end: new Date(Date.UTC(2026, 0, 12, 10, 0, 0)),
      title: "Standup",
      location: null,
    });
  });

  it("a zoned Series keeps the same wall-clock time across a DST transition (America/New_York, spring-forward)", () => {
    // 9am America/New_York on 2026-03-02 is 14:00Z (EST, UTC-5); after
    // spring-forward (2026-03-08 in the US) 9am America/New_York is 13:00Z
    // (EDT, UTC-4). A correct zoned expansion keeps 9am local on both sides.
    const series: MaterialiserSeriesInput = {
      ...BASE_SERIES,
      dtstart: new Date("2026-03-02T14:00:00.000Z"),
      tzid: "America/New_York",
      rrules: ["FREQ=DAILY"],
    };
    const occurrences = materialiseSeries(
      series,
      new Map(),
      new Date("2026-03-01T00:00:00.000Z"),
      new Date("2026-03-10T00:00:00.000Z"),
    );
    const before = occurrences.find(
      (o) => o.originalStart.toISOString() === "2026-03-02T14:00:00.000Z",
    );
    const after = occurrences.find(
      (o) => o.originalStart.toISOString() === "2026-03-09T13:00:00.000Z",
    );
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after?.start.toISOString()).toBe("2026-03-09T13:00:00.000Z");
    // Wall-clock duration preserved across the transition too.
    expect(after?.end.toISOString()).toBe("2026-03-09T14:00:00.000Z");
  });

  it("floating times ship as the same wall clock with no zone conversion", () => {
    const series: MaterialiserSeriesInput = {
      ...BASE_SERIES,
      rrules: ["FREQ=WEEKLY;BYDAY=MO"],
      tzid: null, // floating: no re-zoning ever applied
    };
    const occurrences = materialiseSeries(
      series,
      new Map(),
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 1, 1)),
    );
    for (const occurrence of occurrences) {
      expect(occurrence.start.getUTCHours()).toBe(9);
    }
  });
});
