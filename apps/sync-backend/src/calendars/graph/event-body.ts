import type { SeriesAttendee } from "@mail/shared";
import { type EventReminder, visibleReminders } from "@mail/shared";
import { DateTime } from "luxon";
import type {
  GraphAttendee,
  GraphDateTimeZone,
  GraphDayOfWeek,
  GraphEventWriteBody,
  GraphPatternedRecurrence,
  GraphRecurrencePatternType,
  GraphRecurrenceRange,
} from "./client.js";

/**
 * Builds the Graph `event` resource one outbox push writes (#248) from a
 * Series row — `google/event-body.ts`'s own shape, with the one structural
 * difference ADR-0025 calls out: Graph's `recurrence` is a **structured**
 * `patternedRecurrence`, not an RFC 5545 string, so translating it can fail.
 * `toGraphRecurrence` throws `GraphRecurrenceUntranslatableError` for
 * anything the five-template recurrence editor (`apps/client/src/calendar
 * /recurrence.ts`) never itself authors — `outbox-processor.ts` catches that
 * and rejects the push (a Rollback, never a network call), this ticket's own
 * acceptance line: "nothing untranslatable is written."
 *
 * Deliberately **Series-body-only**, the same scope line `google/event-body
 * .ts` already draws: an Override (a single moved/cancelled instance) is not
 * folded in here. For Graph this isn't just a deferred nicety — a cancelled
 * instance (`series.exdates`) has **no** expression in Graph's structured
 * `recurrencePattern`/`recurrenceRange` at all (unlike Google's own RRULE
 * grammar, which folds an `EXDATE:` line straight into `recurrence`), so
 * `toGraphRecurrence` treats a non-empty `exdates`/`rdates` as untranslatable
 * outright rather than silently dropping it. The only way to express "skip
 * this one occurrence" on Graph is to cancel that occurrence's own event id,
 * which needs per-instance upstream ids this ticket does not create (Override
 * write-back is real additional surface, deferred the same way Google's is).
 */

export class GraphRecurrenceUntranslatableError extends Error {
  constructor(detail: string) {
    super(`Series recurrence has no exact Graph translation: ${detail}`);
    this.name = "GraphRecurrenceUntranslatableError";
  }
}

export interface SeriesForGraphBody {
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  floating: boolean;
  tzid: string | null;
  dtstart: Date;
  durationMs: number;
  rrules: string[];
  rdates: string[];
  exdates: string[];
  transparency: "opaque" | "transparent";
  attendees: SeriesAttendee[];
  reminders: EventReminder[];
}

/** Reads `instant` back as wall-clock components in `tzid` (Luxon) — `tzid: null` means the DB's own "already a UTC-labeled wall clock" convention (`materialiser.ts`'s own doc comment), so its plain UTC getters already are the wall clock. */
function wallClock(instant: Date, tzid: string | null): DateTime {
  return tzid
    ? DateTime.fromJSDate(instant, { zone: tzid })
    : DateTime.fromJSDate(instant, { zone: "utc" });
}

/**
 * Graph's `dateTimeTimeZone` documents `timeZone` as part of the pair, unlike
 * Google's date-time shape (which tolerates an offset-free floating value
 * with no zone at all, `google/event-body.ts#toGoogleDateTime`) — a Wicket
 * Series with no `tzid` (floating) is written here as a plain `UTC`
 * wall-clock value, the closest honest equivalent. **This still needs a
 * live account to confirm**: whether Graph actually accepts an IANA zone
 * name (`tzid` verbatim) in a request body's `timeZone`, versus requiring a
 * Windows time zone name, isn't nailed down by the documented reference —
 * see this ticket's closing comment.
 */
function toGraphDateTime(instant: Date, allDay: boolean, tzid: string | null): GraphDateTimeZone {
  const wall = wallClock(instant, tzid);
  if (allDay) {
    return { dateTime: `${wall.toFormat("yyyy-LL-dd")}T00:00:00.0000000`, timeZone: "UTC" };
  }
  return {
    dateTime: wall.toISO({ includeOffset: false }) ?? wall.toFormat("yyyy-LL-dd'T'HH:mm:ss.SSS"),
    timeZone: tzid ?? "UTC",
  };
}

/** `sunday`-first, matching Graph's own `dayOfWeek` enum order — Luxon's `weekday` is ISO (1 = Monday … 7 = Sunday), so `% 7` maps it onto this array with no branch. */
const DAY_NAMES: readonly GraphDayOfWeek[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function parseRRuleFields(rule: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of rule.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return fields;
}

/** The inverse of `apps/client/src/calendar/recurrence.ts#untilValue` — RFC 5545's `YYYYMMDD` or `YYYYMMDDTHHMMSSZ`, both always UTC per §3.3.10. */
function parseRRuleUntil(value: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(value);
  if (!match) throw new GraphRecurrenceUntranslatableError(`UNTIL=${value}`);
  const [, y, mo, d, h, mi, s] = match;
  if (h === undefined) return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

function patternFor(
  freq: string,
  dtstart: Date,
  tzid: string | null,
): { type: GraphRecurrencePatternType; interval: number } & Record<string, unknown> {
  const wall = wallClock(dtstart, tzid);
  switch (freq) {
    case "DAILY":
      return { type: "daily", interval: 1 };
    case "WEEKLY":
      return {
        type: "weekly",
        interval: 1,
        daysOfWeek: [DAY_NAMES[wall.weekday % 7]],
        firstDayOfWeek: "sunday",
      };
    case "MONTHLY":
      return { type: "absoluteMonthly", interval: 1, dayOfMonth: wall.day };
    case "YEARLY":
      return { type: "absoluteYearly", interval: 1, dayOfMonth: wall.day, month: wall.month };
    default:
      throw new GraphRecurrenceUntranslatableError(`FREQ=${freq}`);
  }
}

function rangeFor(
  until: string | undefined,
  dtstart: Date,
  tzid: string | null,
): GraphRecurrenceRange {
  const startDate = wallClock(dtstart, tzid).toFormat("yyyy-LL-dd");
  if (!until) return { type: "noEnd", startDate };
  const untilWall = wallClock(parseRRuleUntil(until), tzid);
  return {
    type: "endDate",
    startDate,
    endDate: untilWall.toFormat("yyyy-LL-dd"),
    recurrenceTimeZone: tzid ?? "UTC",
  };
}

/**
 * Translates `rrules`/`rdates`/`exdates` into Graph's structured
 * `patternedRecurrence`, or `undefined` for a non-recurring Series — see
 * this file's own doc comment for what throws and why. Restricted, on
 * purpose, to exactly the vocabulary `apps/client/src/calendar/recurrence.ts`
 * can author (`FREQ` alone, `INTERVAL=1` implicit, an optional `UNTIL`): a
 * Series this editor didn't itself create (an inbound one with `BYDAY`, a
 * `COUNT`, a non-1 `INTERVAL`…) is exactly as untranslatable here as it is
 * read-only there.
 */
export function toGraphRecurrence(
  series: Pick<SeriesForGraphBody, "rrules" | "rdates" | "exdates" | "dtstart" | "tzid">,
): GraphPatternedRecurrence | undefined {
  const { rrules, rdates, exdates, dtstart, tzid } = series;

  if (rrules.length === 0) {
    if (exdates.length > 0 || rdates.length > 0) {
      throw new GraphRecurrenceUntranslatableError(
        "RDATE/EXDATE with no RRULE has no Graph equivalent",
      );
    }
    return undefined;
  }
  if (rrules.length > 1) throw new GraphRecurrenceUntranslatableError("more than one RRULE");
  if (exdates.length > 0) {
    throw new GraphRecurrenceUntranslatableError(
      "a cancelled instance (EXDATE) — see this file's own doc comment",
    );
  }
  if (rdates.length > 0) {
    throw new GraphRecurrenceUntranslatableError(
      "an added instance (RDATE) has no Graph equivalent",
    );
  }

  const [rule] = rrules;
  if (!rule) throw new GraphRecurrenceUntranslatableError("empty RRULE");
  const fields = parseRRuleFields(rule);
  const freq = fields.get("FREQ");
  if (!freq) throw new GraphRecurrenceUntranslatableError("RRULE with no FREQ");
  const interval = fields.get("INTERVAL");
  if (interval !== undefined && interval !== "1") {
    throw new GraphRecurrenceUntranslatableError(`INTERVAL=${interval}`);
  }
  for (const unsupported of ["BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "COUNT", "BYYEARDAY"]) {
    if (fields.has(unsupported)) throw new GraphRecurrenceUntranslatableError(unsupported);
  }

  return {
    pattern: patternFor(freq, dtstart, tzid),
    range: rangeFor(fields.get("UNTIL"), dtstart, tzid),
  };
}

function toGraphAttendees(attendees: SeriesAttendee[]): GraphAttendee[] | undefined {
  if (attendees.length === 0) return undefined;
  return attendees.map((attendee) => ({
    emailAddress: { address: attendee.email, name: attendee.name ?? undefined },
  }));
}

/**
 * `reminderMinutesBeforeStart`/`isReminderOn` (#244, ADR-0028: "Graph: one")
 * — Graph's single slot takes only the **first** visible (relative, popup)
 * Reminder; `perEventReminders: 1` (`fold.ts`) is what keeps the editor from
 * ever offering a second one to lose here. `email`/`absolute` Reminders have
 * no Graph representation at all (no `method` field exists on Graph's own
 * reminder) and are silently left out, the same as Google's own untranslatable
 * case (`google/event-body.ts#toGoogleReminders`'s own doc comment). An empty
 * `reminders` array — "use the Calendar's Reminder Default" — turns the
 * reminder off outright rather than guessing at Wicket's own Default:
 * Graph has no calendar-level default to defer to (ADR-0028's own line),
 * unlike Google's `useDefault: true`.
 */
function toGraphReminder(reminders: EventReminder[]): {
  isReminderOn: boolean;
  reminderMinutesBeforeStart?: number;
} {
  const [first] = visibleReminders(reminders);
  if (!first) return { isReminderOn: false };
  return { isReminderOn: true, reminderMinutesBeforeStart: first.minutesBefore };
}

export function buildGraphEventBody(seriesRow: SeriesForGraphBody): GraphEventWriteBody {
  const end = new Date(seriesRow.dtstart.getTime() + seriesRow.durationMs);
  return {
    subject: seriesRow.title,
    body: seriesRow.description
      ? { contentType: "text", content: seriesRow.description }
      : undefined,
    location: seriesRow.location ? { displayName: seriesRow.location } : undefined,
    start: toGraphDateTime(seriesRow.dtstart, seriesRow.allDay, seriesRow.tzid),
    end: toGraphDateTime(end, seriesRow.allDay, seriesRow.tzid),
    isAllDay: seriesRow.allDay,
    recurrence: toGraphRecurrence(seriesRow),
    attendees: toGraphAttendees(seriesRow.attendees),
    showAs: seriesRow.transparency === "transparent" ? "free" : "busy",
    ...toGraphReminder(seriesRow.reminders),
  };
}
