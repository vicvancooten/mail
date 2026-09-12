import { DEFAULT_FIRST_DAY_OF_WEEK, type FirstDayOfWeek } from "@mail/shared";

/**
 * Plain-date arithmetic for the Calendar App's five views (#231). No date
 * library: every operation here is a civil (year, month, day) triple with
 * no time-of-day or zone component, and the small set of operations a grid
 * needs — start of week/month/year, add days, format a `YYYY-MM-DD` key —
 * is cheaper hand-written than pulling in a client-side date dependency for
 * (`materialiser.ts`'s own Luxon stays a sync-backend-only tool; nothing
 * here needs RFC 5545 expansion, only calendar-grid bucketing).
 *
 * Weeks start Monday by default (ISO-8601) — Region Settings' own First Day
 * of the Week (#303) overrides it: every function below that cares takes a
 * `FirstDayOfWeek` parameter defaulting to Monday, so a caller with no
 * Preference yet on hand (a still-loading `usePreference()`) gets the same
 * behaviour this ticket found here.
 *
 * Every label-producing function below also takes an optional BCP-47
 * `locale` (Region Settings' language and region, #303) — omitted, `Intl`
 * picks the viewer's own browser default, same as before this ticket.
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

/**
 * How many days `date` sits after this week's own first day: 0..6, with
 * `firstDayOfWeek` itself landing on 0 — Monday=0..Sunday=6 for the ISO-8601
 * default, or Sunday=0..Saturday=6 once Region Settings picks Sunday (#303).
 * `Date.getDay()`'s own Sunday=0..Saturday=6 is neither of these on its own,
 * which is why every grid computes its "which column" through this rather
 * than `getDay()` directly.
 */
export function isoWeekday(
  date: CivilDate,
  firstDayOfWeek: FirstDayOfWeek = DEFAULT_FIRST_DAY_OF_WEEK,
): number {
  const day = toDateObject(date).getDay();
  return firstDayOfWeek === "sunday" ? day : (day + 6) % 7;
}

export function startOfWeek(
  date: CivilDate,
  firstDayOfWeek: FirstDayOfWeek = DEFAULT_FIRST_DAY_OF_WEEK,
): CivilDate {
  return addDays(date, -isoWeekday(date, firstDayOfWeek));
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

/**
 * One cached `Intl.DateTimeFormat` per (kind, locale) pair — a handful of
 * distinct combinations ever appear in one session (one Region Settings
 * locale, five label kinds), so this never grows unbounded the way building
 * a fresh formatter on every one of a Month/Year grid's ~40 day cells would.
 */
const LABEL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function labelFormatter(
  kind: "weekday" | "month" | "monthShort" | "dayHeading" | "monthHeading",
  locale: string | undefined,
): Intl.DateTimeFormat {
  const key = `${kind}:${locale ?? ""}`;
  let formatter = LABEL_FORMATTERS.get(key);
  if (!formatter) {
    const options: Intl.DateTimeFormatOptions =
      kind === "weekday"
        ? { weekday: "short" }
        : kind === "month"
          ? { month: "long" }
          : kind === "monthShort"
            ? { month: "short" }
            : kind === "dayHeading"
              ? { weekday: "long", month: "long", day: "numeric" }
              : { month: "long", year: "numeric" };
    formatter = new Intl.DateTimeFormat(locale, options);
    LABEL_FORMATTERS.set(key, formatter);
  }
  return formatter;
}

export function weekdayLabel(date: CivilDate, locale?: string): string {
  return labelFormatter("weekday", locale).format(toDateObject(date));
}

export function monthLabel(date: CivilDate, locale?: string): string {
  return labelFormatter("month", locale).format(toDateObject(date));
}

export function monthShortLabel(date: CivilDate, locale?: string): string {
  return labelFormatter("monthShort", locale).format(toDateObject(date));
}

export function dayHeadingLabel(date: CivilDate, locale?: string): string {
  return labelFormatter("dayHeading", locale).format(toDateObject(date));
}

export function monthHeadingLabel(date: CivilDate, locale?: string): string {
  return labelFormatter("monthHeading", locale).format(toDateObject(date));
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
