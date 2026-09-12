import type { Event } from "@mail/shared";
import { addDays, type CivilDate, compareCivilDates, dayKey } from "./calendar-dates.js";

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

export interface CivilInstant extends CivilDate {
  hour: number;
  minute: number;
}

/**
 * An `Event`'s `start`/`end` read as the grid actually needs to place them
 * (ADR-0025, `events.ts`'s own doc comment): a plain timed Event
 * (`!allDay && !floating`) carries a real UTC instant, converted to the
 * viewer's own current zone; an all-day or floating Event is wall clock
 * already — its digits are the civil date/time to render verbatim, never
 * run through `Date`'s own UTC→local conversion a second time.
 */
function civilInstant(iso: string, wallClock: boolean): CivilInstant {
  if (wallClock) {
    const match = ISO_RE.exec(iso);
    if (!match) return { year: 1970, month: 1, day: 1, hour: 0, minute: 0 };
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
    };
  }
  const asDate = new Date(iso);
  return {
    year: asDate.getFullYear(),
    month: asDate.getMonth() + 1,
    day: asDate.getDate(),
    hour: asDate.getHours(),
    minute: asDate.getMinutes(),
  };
}

export function eventStart(event: Event): CivilInstant {
  return civilInstant(event.start, event.allDay || event.floating);
}

export function eventEnd(event: Event): CivilInstant {
  return civilInstant(event.end, event.allDay || event.floating);
}

/**
 * `civilInstant`'s own inverse (#305's drag-to-move): a dragged Occurrence's
 * new position, read as an ordinary `CivilInstant`, back into the wire ISO
 * string a save actually writes. A wall-clock value (`wallClock`, an
 * all-day or floating Occurrence) is rebuilt through `Date.UTC` — the exact
 * "digits as UTC" encoding `civilInstant` reads back off, never the
 * viewer's own zone — so a Month drag that only ever changes the day never
 * drifts the wall-clock hour it preserved. A real timed instant goes through
 * the viewer's own local `Date` constructor instead, `EventEditorPopover.tsx`'s
 * own `fromLocalInputValue` shape, converting the local wall time a Day/Week
 * drag computed into the UTC instant the wire format wants.
 */
export function civilInstantToIso(instant: CivilInstant, wallClock: boolean): string {
  if (wallClock) {
    return new Date(
      Date.UTC(instant.year, instant.month - 1, instant.day, instant.hour, instant.minute, 0, 0),
    ).toISOString();
  }
  return new Date(
    instant.year,
    instant.month - 1,
    instant.day,
    instant.hour,
    instant.minute,
    0,
    0,
  ).toISOString();
}

/**
 * Every day key an Event's chip needs to render on. All-day rows are
 * exclusive-end date pairs (ADR-0025) — a same-day all-day Event's `end` is
 * already the next midnight, so this is what keeps a one-day all-day Event
 * from over-spanning onto that next day: an end that lands exactly at
 * midnight only counts if the Event's start is also midnight of a later
 * day (a genuinely multi-day all-day span), never for the ordinary
 * single-day case.
 */
export function eventDayKeys(event: Event): string[] {
  const start = eventStart(event);
  const end = eventEnd(event);
  const startDate: CivilDate = start;
  let endDate: CivilDate = end;
  const endsAtMidnight = end.hour === 0 && end.minute === 0;
  if (endsAtMidnight && compareCivilDates(end, start) > 0) {
    endDate = addDays(end, -1);
  }
  const keys: string[] = [];
  let cursor = startDate;
  // Bounded: nothing in this App renders a single Occurrence spanning more
  // than a year of grid cells, so this loop always terminates well inside
  // that guard.
  for (let guard = 0; guard < 400 && compareCivilDates(cursor, endDate) <= 0; guard++) {
    keys.push(dayKey(cursor));
    cursor = addDays(cursor, 1);
  }
  return keys.length > 0 ? keys : [dayKey(startDate)];
}

export interface DayBucket {
  allDay: Event[];
  timed: Event[];
}

/** Buckets `events` by the day key(s) they touch, timed Occurrences sorted by start time then title — the grid's one read of "what renders on this cell". */
export function bucketEventsByDay(events: readonly Event[]): Map<string, DayBucket> {
  const byDay = new Map<string, DayBucket>();
  function bucketFor(key: string): DayBucket {
    let bucket = byDay.get(key);
    if (!bucket) {
      bucket = { allDay: [], timed: [] };
      byDay.set(key, bucket);
    }
    return bucket;
  }
  for (const event of events) {
    if (event.status === "cancelled") continue;
    if (event.allDay) {
      for (const key of eventDayKeys(event)) bucketFor(key).allDay.push(event);
      continue;
    }
    for (const key of eventDayKeys(event)) bucketFor(key).timed.push(event);
  }
  for (const bucket of byDay.values()) {
    bucket.timed.sort((left, right) => {
      const startCompare = left.start.localeCompare(right.start);
      return startCompare !== 0 ? startCompare : left.title.localeCompare(right.title);
    });
  }
  return byDay;
}

/** Minutes past midnight, for a timed Occurrence's vertical position on the day/week grid. */
export function minutesOfDay(instant: CivilInstant): number {
  return instant.hour * 60 + instant.minute;
}
