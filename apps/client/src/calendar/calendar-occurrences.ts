import type { Event } from "@mail/shared";
import { civilInstantInZone } from "@mail/shared";
import { addDays, type CivilDate, compareCivilDates, dayKey } from "./calendar-dates.js";

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

interface CivilInstant extends CivilDate {
  hour: number;
  minute: number;
}

/**
 * An `Event`'s `start`/`end` read as the grid actually needs to place them
 * (ADR-0025, `events.ts`'s own doc comment): a plain timed Event
 * (`!allDay && !floating`) carries a real UTC instant, converted to
 * `timeZone` (the Home Time Zone, #303 — `""` for the viewer's own current
 * zone, `region-settings.ts#civilInstantInZone`'s own doc comment); an
 * all-day or floating Event is wall clock already — its digits are the
 * civil date/time to render verbatim, never run through a zone conversion
 * at all.
 */
function civilInstant(iso: string, wallClock: boolean, timeZone: string): CivilInstant {
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
  return civilInstantInZone(iso, timeZone);
}

/** `timeZone` (#303, Home Time Zone) defaults to `""` — the viewer's own current zone, same as before this ticket threaded it through. */
export function eventStart(event: Event, timeZone = ""): CivilInstant {
  return civilInstant(event.start, event.allDay || event.floating, timeZone);
}

export function eventEnd(event: Event, timeZone = ""): CivilInstant {
  return civilInstant(event.end, event.allDay || event.floating, timeZone);
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
export function eventDayKeys(event: Event, timeZone = ""): string[] {
  const start = eventStart(event, timeZone);
  const end = eventEnd(event, timeZone);
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

/** Buckets `events` by the day key(s) they touch, timed Occurrences sorted by start time then title — the grid's one read of "what renders on this cell". `timeZone` (#303, Home Time Zone) decides which day a real-instant Event's start/end land on; default `""` is the viewer's own current zone, unchanged from before this ticket. */
export function bucketEventsByDay(events: readonly Event[], timeZone = ""): Map<string, DayBucket> {
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
      for (const key of eventDayKeys(event, timeZone)) bucketFor(key).allDay.push(event);
      continue;
    }
    for (const key of eventDayKeys(event, timeZone)) bucketFor(key).timed.push(event);
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
