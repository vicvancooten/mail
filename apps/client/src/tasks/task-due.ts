import {
  formatRegionDate,
  formatRegionTime,
  REGION_LOCALE_UNSET,
  type RegionFormatSettings,
} from "@mail/shared";

/**
 * A Task's Due (#253, `@mail/shared`'s `taskSchema#dueDate`/`dueTime` doc
 * comment): a zone-less calendar day plus an optional floating wall-clock
 * time — never a real zoned instant. Every function here either encodes one
 * of those onto the wire's UTC-instant/`"HH:MM"` shape, or reads it back —
 * always with a UTC getter/formatter, never a local one, which is the whole
 * of what "zone-less"/"floating" mean in practice: the same string reads as
 * the same day and the same clock time in every viewer's zone.
 *
 * The three formatters below route through `@mail/shared#formatRegionDate`/
 * `formatRegionTime` (#304) for the same locale/clock-format Region Settings
 * gives Mail and Calendar — `timeZone: "UTC"` forced regardless of `region`,
 * since a due day/time is zone-less by design, never the Home Time Zone.
 */

/** No Region Settings passed in: the viewer's own browser default locale/clock, same as before this ticket. */
const DEFAULT_REGION: Pick<RegionFormatSettings, "locale" | "clockFormat"> = {
  locale: REGION_LOCALE_UNSET,
  clockFormat: "auto",
};

/** `dueDate`'s own wire encoding: a Y-M-D day, always at UTC midnight. */
export function dateOnlyToWireDueDate(ymd: string): string {
  return `${ymd}T00:00:00.000Z`;
}

/** The `<input type="date">` value a wire `dueDate` renders as — its own Y-M-D, read with no zone conversion since the instant already sits at UTC midnight of that day. */
export function wireDueDateToDateInputValue(dueDate: string): string {
  return dueDate.slice(0, 10);
}

/** Today's own Y-M-D in the *User's* local zone — "Today" has to mean their calendar day, not UTC's, before it's re-encoded zone-less for storage. */
export function localDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `localDateInputValue`, `days` local calendar days later — "Tomorrow"/"Next week"'s own arithmetic. */
export function addLocalDays(date: Date, days: number): string {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  return localDateInputValue(next);
}

/** A due day for display, e.g. "Jun 15" — `timeZone: "UTC"` forced so the day never shifts against the viewer's own zone (the day is zone-less, not a real instant to convert). */
export function formatDueDate(
  dueDate: string,
  region: Pick<RegionFormatSettings, "locale"> = DEFAULT_REGION,
): string {
  return formatRegionDate(
    dueDate,
    { locale: region.locale, timeZone: "UTC" },
    { year: undefined, month: "short", day: "numeric" },
  );
}

/** A due time for display, e.g. "2:30 PM" — built off a dummy 1970-01-01 instant and forced to `timeZone: "UTC"`, so the digits typed into the `<input type="time">` come back unchanged regardless of the viewer's own zone (floating, not a real instant). */
export function formatDueTime(
  dueTime: string,
  region: Pick<RegionFormatSettings, "locale" | "clockFormat"> = DEFAULT_REGION,
): string {
  return formatRegionTime(`1970-01-01T${dueTime}:00.000Z`, { ...region, timeZone: "UTC" });
}

/** Upcoming's own day-group heading (#254), e.g. "Mon, Jun 15" — `formatDueDate`'s own zone-forced approach, plus a weekday: a day group is scanned across many Tasks at once, so it earns more context than a single row's due chip does. */
export function formatUpcomingDayHeading(
  dueDate: string,
  region: Pick<RegionFormatSettings, "locale"> = DEFAULT_REGION,
): string {
  return formatRegionDate(
    dueDate,
    { locale: region.locale, timeZone: "UTC" },
    { year: undefined, weekday: "short", month: "short", day: "numeric" },
  );
}

/**
 * Whether a (possibly completed) Task's due day has passed — string
 * comparison of two Y-M-D days rather than an epoch/`Date.now()` compare,
 * since a zone-less day has no single instant it "becomes" past at: it's
 * overdue once it's no longer the User's own today or a day after it, in
 * the User's own local calendar, not any particular moment in UTC.
 */
export function isOverdue(dueDate: string, now: Date = new Date()): boolean {
  return wireDueDateToDateInputValue(dueDate) < localDateInputValue(now);
}

/** Board mode's own due swimlane (#256's own five buckets), most-urgent first — `task-board.ts#buildSwimlaneRows` renders empty buckets away, so this ordering is what a partial board still respects. */
export type DueBucket = "overdue" | "today" | "thisWeek" | "later" | "noDate";

export const DUE_BUCKETS: { id: DueBucket; label: string }[] = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "thisWeek", label: "This week" },
  { id: "later", label: "Later" },
  { id: "noDate", label: "No date" },
];

/**
 * Which of the five due buckets a (possibly null, possibly completed) due
 * day falls into — `isOverdue`'s own zone-less day-string compare, extended
 * to "This week" (the 6 local calendar days after today, a fixed window
 * rather than a Monday-anchored calendar week: nothing in the ticket names a
 * week start, and a rolling window needs no timezone-sensitive "start of
 * week" of its own) and "Later" (everything past that window). A completed
 * Task still buckets by its own due day — the Done column is what separates
 * complete from active, not this.
 */
export function dueBucket(dueDate: string | null, now: Date = new Date()): DueBucket {
  if (dueDate === null) return "noDate";
  const day = wireDueDateToDateInputValue(dueDate);
  const today = localDateInputValue(now);
  if (day < today) return "overdue";
  if (day === today) return "today";
  return day <= addLocalDays(now, 6) ? "thisWeek" : "later";
}
