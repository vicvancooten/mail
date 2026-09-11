import type { EventReminder, SeriesAttendee } from "@mail/shared";
import type {
  GoogleEventAttendee,
  GoogleEventDateTime,
  GoogleEventReminder,
  GoogleEventWriteBody,
} from "./client.js";

/**
 * Builds the Google Event resource one outbox push writes (#237) from a
 * Series row — `calendars/materialiser.ts`'s own DATE-TIME convention
 * reversed: a Series' `dtstart`/`durationMs`/`rrules`/`rdates`/`exdates` are
 * this Series' own storage form (`db/schema.ts#series`'s doc comment), and
 * this is the one place that turns that back into Google's own wire shape.
 *
 * Deliberately **Series-body-only**: an Override (a single moved/retitled
 * instance) is not folded in here — pushing per-instance Overrides upstream
 * as Google's own "this recurring instance differs" event rows is real
 * additional surface this ticket does not cover (see the ticket's closing
 * comment). A Series with Overrides still pushes its master body correctly;
 * only the Overrides themselves stay Wicket-local until that follow-up
 * lands.
 */

interface SeriesForGoogleBody {
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

/** `Date.toISOString()` always ends in `Z` — stripping it is what turns a UTC-labeled wall-clock container back into Google's own "floating" `dateTime` (no offset, no zone). */
function stripTrailingZ(iso: string): string {
  return iso.endsWith("Z") ? iso.slice(0, -1) : iso;
}

function toGoogleDateTime(
  instant: Date,
  allDay: boolean,
  floating: boolean,
  tzid: string | null,
): GoogleEventDateTime {
  if (allDay) return { date: instant.toISOString().slice(0, 10) };
  if (floating) return { dateTime: stripTrailingZ(instant.toISOString()) };
  return { dateTime: instant.toISOString(), timeZone: tzid ?? undefined };
}

/** RFC 5545 lines, `RRULE:`/`RDATE:`/`EXDATE:` — `undefined` (not `[]`) for a non-recurring Series, matching Google's own convention of omitting `recurrence` entirely for a singleton event. */
function toGoogleRecurrence(
  rrules: string[],
  rdates: string[],
  exdates: string[],
): string[] | undefined {
  const lines = [
    ...rrules.map((rule) => `RRULE:${rule}`),
    ...rdates.map((date) => `RDATE:${date}`),
    ...exdates.map((date) => `EXDATE:${date}`),
  ];
  return lines.length > 0 ? lines : undefined;
}

/**
 * `Series.reminders` back into Google's own `reminders` shape (#244,
 * ADR-0028's "per-Event Reminders mirror both ways"). An empty array means
 * "this Event asks for the Calendar's Reminder Default" — Wicket's own
 * policy, never Google's (ADR-0028's own "Considered options": the Default
 * itself deliberately does not mirror) — so the honest Google-side
 * equivalent is `useDefault: true`, deferring to *Google's* own default
 * rather than pushing Wicket's. A `kind: "absolute"` Reminder (no producer
 * on this branch's ancestry yet) has no Google representation at all and is
 * silently left out of `overrides`, the same "nothing to translate it to"
 * posture `toGoogleRecurrence`-style adapters take for an untranslatable
 * value that was never going to be written anyway.
 */
function toGoogleReminders(reminders: EventReminder[]): {
  useDefault: boolean;
  overrides?: GoogleEventReminder[];
} {
  if (reminders.length === 0) return { useDefault: true };
  const overrides = reminders
    .filter(
      (reminder): reminder is Extract<EventReminder, { kind: "relative" }> =>
        reminder.kind === "relative",
    )
    .map((reminder) => ({ method: reminder.method, minutes: reminder.minutesBefore }));
  return { useDefault: false, overrides };
}

/**
 * `responseStatus` rides every push (#240, ADR-0027) — Google only ever
 * lets an attendee's own PATCH move *their own* entry's `responseStatus`
 * (any other attendee's is ignored server-side), so folding it into the
 * same full-body `PATCH` every other `upsert` already sends needs no
 * special-cased "respond" request shape of its own: `series-store.ts
 * #answerInvitation` rewrites the local row first, and this function just
 * carries whatever `attendees` now says, same as every other field here.
 */
function toGoogleAttendees(attendees: SeriesAttendee[]): GoogleEventAttendee[] | undefined {
  if (attendees.length === 0) return undefined;
  return attendees.map((attendee) => ({
    email: attendee.email,
    displayName: attendee.name ?? undefined,
    responseStatus: attendee.responseStatus,
  }));
}

export function buildGoogleEventBody(seriesRow: SeriesForGoogleBody): GoogleEventWriteBody {
  const end = new Date(seriesRow.dtstart.getTime() + seriesRow.durationMs);
  return {
    summary: seriesRow.title,
    description: seriesRow.description ?? undefined,
    location: seriesRow.location ?? undefined,
    start: toGoogleDateTime(
      seriesRow.dtstart,
      seriesRow.allDay,
      seriesRow.floating,
      seriesRow.tzid,
    ),
    end: toGoogleDateTime(end, seriesRow.allDay, seriesRow.floating, seriesRow.tzid),
    recurrence: toGoogleRecurrence(seriesRow.rrules, seriesRow.rdates, seriesRow.exdates),
    attendees: toGoogleAttendees(seriesRow.attendees),
    transparency: seriesRow.transparency,
    reminders: toGoogleReminders(seriesRow.reminders),
  };
}
