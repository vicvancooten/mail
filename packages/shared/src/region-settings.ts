import { z } from "zod";

/**
 * Region Settings (#303, parent #302/#270): the User-scoped, synced group
 * that decides how a date or a time *reads* — language and region, clock,
 * first day of the week, and the Calendar's default view. `Preference`
 * (`sync.ts`) owns the fields; this module owns their schemas, defaults, and
 * the one shared formatting helper every date/time in Calendar routes
 * through (Mail's own dates are the next ticket, per #303's scope note).
 *
 * No date library: every helper here leans on `Intl` alone, the same
 * "cheaper hand-written than a client-side date dependency" call
 * `calendar-dates.ts` already made for plain civil-date arithmetic.
 */

/**
 * A BCP-47 locale tag (e.g. `"en-US"`), or `REGION_LOCALE_UNSET` for "not
 * seeded yet" — the same sentinel-not-a-default posture `HOME_TIME_ZONE_UNSET`
 * gives Home Time Zone (`sync.ts`'s own doc comment): seeding a real value
 * from `navigator.language` is the signing-in device's job
 * (`client/src/settings/use-seed-region-locale.ts`), never a server-side
 * guess. Every formatter below treats `""` as "let `Intl` pick the viewer's
 * own default" — passing `undefined` rather than `""` to its constructors.
 */
export const REGION_LOCALE_UNSET = "";

/** Clock style (#303): `"auto"` reads whatever the resolved locale's own convention is, `"12"`/`"24"` force one regardless of locale. */
export const clockFormatSchema = z.enum(["auto", "12", "24"]);
export type ClockFormat = z.infer<typeof clockFormatSchema>;
export const DEFAULT_CLOCK_FORMAT: ClockFormat = "auto";

/** First day of the week (#303): Calendar's Week/Work Week/Month/Year grids all anchor on this — default Monday (ISO-8601), same default `calendar-dates.ts` hard-coded before this ticket. */
export const firstDayOfWeekSchema = z.enum(["monday", "sunday"]);
export type FirstDayOfWeek = z.infer<typeof firstDayOfWeekSchema>;
export const DEFAULT_FIRST_DAY_OF_WEEK: FirstDayOfWeek = "monday";

/**
 * Calendar's five views (`calendar-url.ts#CALENDAR_VIEWS`, #231) — declared
 * here rather than only client-side because Region Settings' Default View
 * (#303) is a synced `Preference` field, so the Sync Backend and its schema
 * need the same enum. `calendar-url.ts` re-exports this rather than
 * declaring a second one, so there is exactly one list of views to keep in
 * sync with the grid components.
 */
export const calendarViewSchema = z.enum(["day", "workweek", "week", "month", "year"]);
export type CalendarView = z.infer<typeof calendarViewSchema>;
export const DEFAULT_CALENDAR_VIEW: CalendarView = "week";

/** The fields a date/time formatter needs off `Preference` — a narrower shape than the whole row, so a caller building one from scratch (tests, `formatDueDate`'s eventual Mail sibling) never has to fake unrelated fields. */
export interface RegionFormatSettings {
  locale: string;
  clockFormat: ClockFormat;
  /** IANA zone, or `""` for the viewer's own current zone (`HOME_TIME_ZONE_UNSET`, duplicated as a literal here so this module needs no import from `sync.ts` — the two are kept in step by `sync.ts`'s own re-export). */
  timeZone: string;
}

function resolveLocale(locale: string): string | undefined {
  return locale === REGION_LOCALE_UNSET ? undefined : locale;
}

function resolveTimeZone(timeZone: string): string | undefined {
  return timeZone === "" ? undefined : timeZone;
}

/** `undefined` (browser default) for `"auto"`, otherwise an explicit `hour12` — the one place a forced 12/24 clock overrides whatever the locale would otherwise pick. */
function resolveHour12(clockFormat: ClockFormat): boolean | undefined {
  if (clockFormat === "12") return true;
  if (clockFormat === "24") return false;
  return undefined;
}

/** The civil (year, month, day, hour, minute) an instant reads as in one IANA zone — Calendar's one escape from a date library for zone conversion: `Intl.DateTimeFormat#formatToParts`, never manual offset math. */
export interface RegionCivilInstant {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

// Keyed by zone (or `""` for the viewer's own): a handful of zones ever
// appear in one session, so this never grows unbounded the way a per-call
// `new Intl.DateTimeFormat` would waste cycles rebuilding on every Occurrence.
const CIVIL_PARTS_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function civilPartsFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let formatter = CIVIL_PARTS_FORMATTERS.get(key);
  if (!formatter) {
    // Locale-independent on purpose (`"en-US"`, fixed): this only ever reads
    // back numeric parts, never renders anything a viewer sees, so the locale
    // that produced them is irrelevant — `formatRegionDate`/`formatRegionTime`
    // below are what a viewer actually reads, and they resolve locale afresh.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    CIVIL_PARTS_FORMATTERS.set(key, formatter);
  }
  return formatter;
}

/**
 * Reads a UTC instant's wall-clock fields in `timeZone` (or the viewer's own
 * zone when `""`) — the one place a real Event instant becomes "what hour
 * and minute does this land on, in the Home Time Zone" rather than `Date`'s
 * own local getters, which only ever answer for the *device's* zone.
 */
export function civilInstantInZone(iso: string, timeZone: string): RegionCivilInstant {
  const parts = civilPartsFormatter(resolveTimeZone(timeZone)).formatToParts(new Date(iso));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/** A date, formatted for `region`'s locale and time zone — `options` layers on top (e.g. `{ weekday: "long" }` for a heading), `year`/`month`/`day` always present as the baseline every caller needs. */
export function formatRegionDate(
  iso: string,
  region: Pick<RegionFormatSettings, "locale" | "timeZone">,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat(resolveLocale(region.locale), {
    timeZone: resolveTimeZone(region.timeZone),
    year: "numeric",
    month: "long",
    day: "numeric",
    ...options,
  }).format(new Date(iso));
}

/** A time-of-day, formatted for `region`'s locale, clock and time zone — e.g. "2:30 PM" or "14:30" depending on `clockFormat`. */
export function formatRegionTime(
  iso: string,
  region: Pick<RegionFormatSettings, "locale" | "clockFormat" | "timeZone">,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat(resolveLocale(region.locale), {
    timeZone: resolveTimeZone(region.timeZone),
    hour: "numeric",
    minute: "2-digit",
    hour12: resolveHour12(region.clockFormat),
    ...options,
  }).format(new Date(iso));
}

/**
 * An hour-rail label, e.g. "9 AM" or "09" — `DayTimeGrid.tsx`'s own gutter,
 * `formatRegionTime`'s minute-less sibling. Built off a dummy UTC instant and
 * forced to `timeZone: "UTC"` (`task-due.ts#formatDueTime`'s own trick): the
 * hour rail's own row labels are zone-less by construction — the grid places
 * Occurrences at whatever hour they already read as in the Home Time Zone
 * (`civilInstantInZone`), so this only ever has to render that hour number,
 * never convert one.
 */
export function formatHourLabel(
  hour: number,
  region: Pick<RegionFormatSettings, "locale" | "clockFormat">,
): string {
  return new Intl.DateTimeFormat(resolveLocale(region.locale), {
    timeZone: "UTC",
    hour: "numeric",
    hour12: resolveHour12(region.clockFormat),
  }).format(new Date(Date.UTC(2000, 0, 1, hour)));
}
