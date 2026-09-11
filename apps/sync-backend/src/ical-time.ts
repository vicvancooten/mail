import type ICAL from "ical.js";
import { DateTime } from "luxon";

/**
 * Converts a parsed `ICAL.Time` into the real UTC instant its `TZID` names,
 * rather than trusting `ICAL.Time#toJSDate()` on its own.
 *
 * Without a registered `VTIMEZONE` component — which most real `.ics`
 * producers omit for a well-known IANA zone name, and which this parser
 * never registers — `ical.js` falls back to reading the wall-clock value in
 * the *process's own* local time zone. That's correct only by coincidence,
 * when the process happens to already run in the zone the event names;
 * everywhere else (including any UTC-`TZ` CI runner) it's silently off by
 * that zone's offset. `calendars/materialiser.ts` and
 * `calendars/reminder-due-store.ts` already sidestep this the same way, for
 * the same reason — this is that pattern, shared.
 */
export function icalTimeToUtcDate(time: ICAL.Time, tzid: string | null): Date {
  if (tzid) {
    const zoned = DateTime.fromObject(
      {
        year: time.year,
        month: time.month,
        day: time.day,
        hour: time.hour,
        minute: time.minute,
        second: time.second,
      },
      { zone: tzid },
    );
    if (zoned.isValid) return zoned.toUTC().toJSDate();
  }
  return time.toJSDate();
}
