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
 * The row cluster's own list (#76). `SNOOZE_PRESETS[0]` — "Later today" — is
 * also what a bare swipe-left commits to with no picker in reach
 * (`ThreadRow.tsx`): the one preset that never needs a specific hour picked,
 * just an offset from now.
 */
export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { label: "Later today", until: (now) => hoursFromNow(now, 3) },
  { label: "Tomorrow", until: (now) => nextDayAt(now, MORNING_HOUR) },
  { label: "Next week", until: (now) => nextWeekdayAt(now, /* Monday */ 1, MORNING_HOUR) },
];

/** The instant a bare swipe-left commits to (`useSwipeToTriage.ts`) — no menu, so no per-Thread choice to make. */
export function defaultSwipeSnoozeUntil(now: Date = new Date()): Date {
  const preset = SNOOZE_PRESETS[0];
  if (!preset) throw new Error("SNOOZE_PRESETS must not be empty");
  return preset.until(now);
}
