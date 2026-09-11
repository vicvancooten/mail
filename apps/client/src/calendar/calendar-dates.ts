/**
 * Plain-date arithmetic for the Calendar App's five views (#231). No date
 * library: every operation here is a civil (year, month, day) triple with
 * no time-of-day or zone component, and the small set of operations a grid
 * needs — start of week/month/year, add days, format a `YYYY-MM-DD` key —
 * is cheaper hand-written than pulling in a client-side date dependency for
 * (`materialiser.ts`'s own Luxon stays a sync-backend-only tool; nothing
 * here needs RFC 5545 expansion, only calendar-grid bucketing).
 *
 * Weeks start Monday (ISO-8601) — a routine call with no stated User
 * preference to read instead; see this ticket's closing report.
 */

export interface CivilDate {
  year: number;
  month: number; // 1-12
  day: number;
}

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today, in the viewer's own local zone — never UTC, which can read as tomorrow or yesterday depending on the offset. */
export function today(): CivilDate {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

export function dayKey(date: CivilDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** Parses a `YYYY-MM-DD` key back into a `CivilDate`, or `null` for anything else — callers fall back to `today()`. */
export function parseDayKey(key: string | undefined): CivilDate | null {
  if (!key) return null;
  const match = DAY_KEY_RE.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-trips through Date to reject an out-of-range day (Feb 30) rather
  // than silently normalizing it into March.
  const asDate = new Date(year, month - 1, day);
  if (
    asDate.getFullYear() !== year ||
    asDate.getMonth() !== month - 1 ||
    asDate.getDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function toDateObject(date: CivilDate): Date {
  return new Date(date.year, date.month - 1, date.day);
}

function fromDateObject(date: Date): CivilDate {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

export function addDays(date: CivilDate, count: number): CivilDate {
  const asDate = toDateObject(date);
  asDate.setDate(asDate.getDate() + count);
  return fromDateObject(asDate);
}

export function addMonths(date: CivilDate, count: number): CivilDate {
  const asDate = toDateObject(date);
  asDate.setMonth(asDate.getMonth() + count);
  return fromDateObject(asDate);
}

export function compareCivilDates(left: CivilDate, right: CivilDate): number {
  return dayKey(left) < dayKey(right) ? -1 : dayKey(left) > dayKey(right) ? 1 : 0;
}

/** Monday=0 .. Sunday=6, unlike `Date.getDay()`'s Sunday=0 — every week in this App starts Monday. */
export function isoWeekday(date: CivilDate): number {
  return (toDateObject(date).getDay() + 6) % 7;
}

export function startOfWeek(date: CivilDate): CivilDate {
  return addDays(date, -isoWeekday(date));
}

export function startOfMonth(date: CivilDate): CivilDate {
  return { year: date.year, month: date.month, day: 1 };
}

export function daysInMonth(date: CivilDate): number {
  return new Date(date.year, date.month, 0).getDate();
}

export function startOfYear(date: CivilDate): CivilDate {
  return { year: date.year, month: 1, day: 1 };
}

/** `count` consecutive days starting at `start`, inclusive. */
export function dayRange(start: CivilDate, count: number): CivilDate[] {
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}

export function isSameDay(left: CivilDate, right: CivilDate): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

const WEEKDAY_LABEL = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const MONTH_LABEL = new Intl.DateTimeFormat(undefined, { month: "long" });
const MONTH_SHORT_LABEL = new Intl.DateTimeFormat(undefined, { month: "short" });
const DAY_HEADING_LABEL = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const MONTH_HEADING_LABEL = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

export function weekdayLabel(date: CivilDate): string {
  return WEEKDAY_LABEL.format(toDateObject(date));
}

export function monthLabel(date: CivilDate): string {
  return MONTH_LABEL.format(toDateObject(date));
}

export function monthShortLabel(date: CivilDate): string {
  return MONTH_SHORT_LABEL.format(toDateObject(date));
}

export function dayHeadingLabel(date: CivilDate): string {
  return DAY_HEADING_LABEL.format(toDateObject(date));
}

export function monthHeadingLabel(date: CivilDate): string {
  return MONTH_HEADING_LABEL.format(toDateObject(date));
}

/**
 * `[start, end)` in ISO instant form for the grid's own visible `days`
 * (#232) — midnight of the first day to midnight after the last, both in
 * the viewer's local zone, the same boundary `useEventsForRange` compares
 * against the Event Window's own edges.
 */
export function civilDateRangeToIso(days: readonly CivilDate[]): { start: string; end: string } {
  const first = days[0] ?? today();
  const last = days[days.length - 1] ?? first;
  const start = new Date(first.year, first.month - 1, first.day);
  const end = new Date(last.year, last.month - 1, last.day + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

const EDGE_DATE_LABEL = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** How the Event Window's own edge reads in the "fetched, not cached" banner (#232's acceptance line: both edges are drawn, never inferred). */
export function formatWindowEdge(iso: string): string {
  return EDGE_DATE_LABEL.format(new Date(iso));
}
