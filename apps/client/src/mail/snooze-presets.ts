import {
  civilInstantInZone,
  formatRegionDate,
  formatRegionTime,
  REGION_LOCALE_UNSET,
  type RegionFormatSettings,
} from "@mail/shared";

/**
 * Snooze's preset times (#76: "a small set of preset times plus a custom
 * pick"). Each preset is a pure function of `now` — never a hand-picked
 * absolute date — so a snooze offered at 9am and one offered at 9pm compute
 * sensibly different targets, and so `ThreadRow.tsx`'s own default (swipe
 * left, with no picker in reach) can reuse the very same function the menu
 * renders instead of guessing a second constant.
 */

export interface SnoozePreset {
  label: string;
  /** Computes the absolute wake instant from `now` — never memoized, so a menu left open across midnight still offers today's times. */
  until: (now: Date) => Date;
}

/** `now` plus this many hours, unchanged calendar day or not — "Later today" is deliberately not clamped to daylight hours; a snooze at 11pm still wakes a few hours later. */
function hoursFromNow(now: Date, hours: number): Date {
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

/** The next calendar day at the given local hour, `:00`. */
function nextDayAt(now: Date, hour: number): Date {
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  target.setHours(hour, 0, 0, 0);
  return target;
}

/** The next occurrence of `targetDay` (`0`=Sunday…`6`=Saturday) strictly after today, at the given local hour. Always at least a day out, even when today already is `targetDay`. */
function nextWeekdayAt(now: Date, targetDay: number, hour: number): Date {
  const target = new Date(now);
  const daysAhead = (targetDay - target.getDay() + 7) % 7 || 7;
  target.setDate(target.getDate() + daysAhead);
  target.setHours(hour, 0, 0, 0);
  return target;
}

/** 8am local — every preset below wakes a Thread at the start of a working day rather than mid-sleep. */
const MORNING_HOUR = 8;

/**
 * The row cluster's own list (#76) — `ThreadRow.tsx`'s Snooze button opens
 * `SnoozeMenu` for a preset/custom pick. Snooze is no longer a swipe outcome
 * (#149 removed it from `useSwipeToTriage.ts`: right is Done, left is Trash),
 * so every pick here always goes through that menu now — no more "bare
 * swipe-left, no picker in reach" default to compute.
 */
export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { label: "Later today", until: (now) => hoursFromNow(now, 3) },
  { label: "Tomorrow", until: (now) => nextDayAt(now, MORNING_HOUR) },
  { label: "Next week", until: (now) => nextWeekdayAt(now, /* Monday */ 1, MORNING_HOUR) },
];

/** No Region Settings passed in: the viewer's own browser default locale/clock, same as before this ticket. */
const DEFAULT_REGION: Pick<RegionFormatSettings, "locale" | "clockFormat" | "timeZone"> = {
  locale: REGION_LOCALE_UNSET,
  clockFormat: "auto",
  timeZone: "",
};

/**
 * A preset/custom snooze instant, for display next to its button (#304): the
 * clock reads in `region`'s own locale/clock format, same as every other
 * Mail date/time surface this ticket touched. Same-day-as-`now` *in
 * `region`'s own time zone* (`civilInstantInZone`, not the device's own
 * getters — otherwise the day boundary this picks could disagree with the
 * very zone `formatRegionTime` below reads back) shows a bare time ("11:00
 * PM"/"23:00"); anything further out earns a weekday and date ahead of it
 * ("Mon, Jun 22, 8:00 AM") — `task-due.ts#formatUpcomingDayHeading`'s own "a
 * group scanned at a glance earns more context than a single row" call,
 * applied to one row's own snooze target instead of a whole day group.
 */
export function formatSnoozeUntil(
  until: Date,
  now: Date,
  region: Pick<RegionFormatSettings, "locale" | "clockFormat" | "timeZone"> = DEFAULT_REGION,
): string {
  const iso = until.toISOString();
  const time = formatRegionTime(iso, region);
  const untilCivil = civilInstantInZone(iso, region.timeZone);
  const nowCivil = civilInstantInZone(now.toISOString(), region.timeZone);
  const sameLocalDay =
    untilCivil.year === nowCivil.year &&
    untilCivil.month === nowCivil.month &&
    untilCivil.day === nowCivil.day;
  if (sameLocalDay) return time;
  const date = formatRegionDate(iso, region, {
    year: undefined,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${date}, ${time}`;
}
