import ICAL from "ical.js";
import { DateTime } from "luxon";
import type { RRuleSet } from "rrule";
import rrulePackage from "rrule";

// `rrule`'s CommonJS build (`dist/es5/rrule.js`, a webpack UMD bundle) defines
// its named exports through property-getter descriptors Node's cjs-module-
// lexer cannot statically detect, so `import { RRule, RRuleSet } from "rrule"`
// throws "Named export 'RRule' not found" at runtime under ESM — passes
// under Vitest (which transpiles through esbuild, blind to this) but fails
// the moment the built `dist/` actually runs under plain Node. The default
// import + destructure below is Node's own suggested fix for exactly this
// class of CJS/ESM interop gap.
const { RRule, RRuleSet: RRuleSetCtor } = rrulePackage;

/**
 * The materialiser (#230, ADR-0025): derives Occurrence rows from a Series
 * plus its Overrides, for a bounded window — never enumerating a
 * never-ending Series past the window edge (this ticket's acceptance line).
 *
 * `ical.js` validates each `rrules` entry against RFC 5545 grammar before
 * `rrule` expands it (`docs/research/0163-icalendar-recurrence-tooling.md`'s
 * recommendation: `ical.js`'s own `RecurExpansion` has admitted gaps —
 * BYWEEKNO, a 48-month BYDAY+BYMONTHDAY cap, an open BYSETPOS bug — so
 * `rrule` does the actual expansion math while `ical.js` only checks the
 * string is a well-formed RRULE. Neither library, nor Luxon, ever reaches
 * the Client bundle — this module is Sync-Backend-only.
 *
 * ## The wall-clock/instant boundary
 *
 * `rrule` does its own date arithmetic on plain `Date` objects it treats as
 * "floating, UTC-labeled" values (its own README: "every `Date` rrule.js
 * hands back is a UTC-labeled container for a floating wall-clock value").
 * That is exactly the representation a **floating** or **all-day** Series'
 * `dtstart`/`rdates`/`exdates` are already stored in (`db/schema.ts#series`),
 * so those two cases feed `rrule` directly with no conversion.
 *
 * A **zoned** Series (`tzid` set) stores genuine UTC instants instead, so
 * every value crosses a round trip through this Series' own `tzid`: convert
 * to wall-clock components in that zone, hand rrule the UTC-labeled
 * container holding those components (so a `FREQ=DAILY` rule advances
 * calendar days, not fixed 24-hour spans, across a DST boundary), then
 * convert rrule's output back to a real instant the same way. This is the
 * "Luxon re-zones `rrule`'s floating/UTC output" `rrule`'s own README
 * recipe names, applied once per occurrence rather than once for the whole
 * series, which is what keeps a DST transition from shifting every
 * occurrence on the wrong side of it by an hour.
 */

export interface MaterialiserSeriesInput {
  dtstart: Date;
  durationMs: number;
  rrules: string[];
  rdates: string[];
  exdates: string[];
  tzid: string | null;
  title: string;
  location: string | null;
}

export interface OverrideInput {
  originalStart: Date;
  start: Date | null;
  end: Date | null;
  title: string | null;
  location: string | null;
}

export interface MaterialisedOccurrence {
  originalStart: Date;
  start: Date;
  end: Date;
  title: string;
  location: string | null;
}

/** Projects a real instant onto the "UTC-labeled wall clock" container `rrule` expects, in `tzid` — a no-op when `tzid` is `null` (already-floating/all-day values). */
function toRRuleSpace(instant: Date, tzid: string | null): Date {
  if (!tzid) return instant;
  const wall = DateTime.fromJSDate(instant, { zone: tzid });
  return new Date(
    Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second,
      wall.millisecond,
    ),
  );
}

/** The inverse of `toRRuleSpace`: reads a "UTC-labeled wall clock" container's components back as wall-clock components in `tzid`, resolving the real instant they name — a no-op when `tzid` is `null`. */
function fromRRuleSpace(wallClock: Date, tzid: string | null): Date {
  if (!tzid) return wallClock;
  return DateTime.fromObject(
    {
      year: wallClock.getUTCFullYear(),
      month: wallClock.getUTCMonth() + 1,
      day: wallClock.getUTCDate(),
      hour: wallClock.getUTCHours(),
      minute: wallClock.getUTCMinutes(),
      second: wallClock.getUTCSeconds(),
      millisecond: wallClock.getUTCMilliseconds(),
    },
    { zone: tzid },
  ).toJSDate();
}

function buildRRuleSet(series: MaterialiserSeriesInput): RRuleSet {
  const dtstart = toRRuleSpace(series.dtstart, series.tzid);
  const set = new RRuleSetCtor();

  if (series.rrules.length === 0) {
    // "A non-recurring Event is a Series with no rule and one Occurrence"
    // (this ticket's own body) — `dtstart` is that one Occurrence.
    set.rdate(dtstart);
  }
  for (const ruleText of series.rrules) {
    // Syntactic validation only (see this module's own doc comment) — lets
    // a malformed RRULE fail loudly here rather than expand into silent
    // nonsense.
    ICAL.Recur.fromString(ruleText);
    const options = RRule.parseString(ruleText);
    set.rrule(new RRule({ ...options, dtstart }));
  }
  for (const rdateText of series.rdates) {
    set.rdate(toRRuleSpace(new Date(rdateText), series.tzid));
  }
  for (const exdateText of series.exdates) {
    set.exdate(toRRuleSpace(new Date(exdateText), series.tzid));
  }
  return set;
}

/**
 * Expands one Series into its Occurrence rows within `[windowStart,
 * windowEnd]`, applying each matching Override. `overridesByOriginalStart`
 * is keyed by the occurrence's real-instant `originalStart` (its
 * `toISOString()`, matching an Occurrence row's own id convention) —
 * `series-store.ts#rematerialiseSeries` builds it from the Series' own
 * Override rows.
 *
 * `RRuleSet#between` is `rrule`'s bounded, windowed query — never `all()` —
 * so a never-ending Series is expanded only to `windowEnd`, never
 * enumerated (this ticket's acceptance line).
 */
export function materialiseSeries(
  series: MaterialiserSeriesInput,
  overridesByOriginalStart: Map<string, OverrideInput>,
  windowStart: Date,
  windowEnd: Date,
): MaterialisedOccurrence[] {
  const set = buildRRuleSet(series);
  const wallClockStarts = set.between(
    toRRuleSpace(windowStart, series.tzid),
    toRRuleSpace(windowEnd, series.tzid),
    true,
  );

  return wallClockStarts.map((wallClockStart) => {
    const originalStart = fromRRuleSpace(wallClockStart, series.tzid);
    const override = overridesByOriginalStart.get(originalStart.toISOString());

    const wallClockEnd = new Date(wallClockStart.getTime() + series.durationMs);
    const defaultEnd = fromRRuleSpace(wallClockEnd, series.tzid);

    return {
      originalStart,
      start: override?.start ?? originalStart,
      end: override?.end ?? defaultEnd,
      title: override?.title ?? series.title,
      location: override?.location ?? series.location,
    };
  });
}
