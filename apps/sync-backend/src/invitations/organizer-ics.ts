import ICAL from "ical.js";
import { DateTime } from "luxon";

/**
 * The organiser-side iMIP `REQUEST`/`CANCEL` a self-scheduled Calendar sends
 * (#242, ADR-0027) — `reply-ics.ts`'s own mirror image: that one builds a
 * minimal `REPLY` (no `DTSTART`/`RRULE`, the organiser already has those);
 * this builds the **full** `VEVENT` a recipient's own calendar client needs
 * to render the Event at all. Property order follows RFC 5545's own
 * `eventprop` grouping strictly (`UID`, `SEQUENCE`, `DTSTAMP`, `ORGANIZER`,
 * `DTSTART`/`DTEND`, `SUMMARY`/`DESCRIPTION`/`LOCATION`, `ATTENDEE`s,
 * `RRULE`/`RDATE`/`EXDATE`, `RECURRENCE-ID`, `STATUS`) — "new Outlook"
 * enforces ordering the RFC does not otherwise police (this ticket's own
 * acceptance line).
 */

export type OrganizerIcsMethod = "REQUEST" | "CANCEL";

export interface OrganizerIcsAttendee {
  address: string;
  name: string | null;
}

export interface OrganizerIcsInput {
  method: OrganizerIcsMethod;
  uid: string;
  sequence: number;
  organizer: { address: string; name: string | null };
  /** Only the recipients *this* `.ics` addresses — a substantive edit carries every current Attendee, an added-Attendee-alone `REQUEST` carries only them (ADR-0027). */
  attendees: OrganizerIcsAttendee[];
  summary: string | null;
  description: string | null;
  location: string | null;
  dtstart: Date;
  durationMs: number;
  allDay: boolean;
  floating: boolean;
  tzid: string | null;
  rrules: string[];
  rdates: string[];
  exdates: string[];
  /** RFC 5545 date-time string, in the Series' own DATE-TIME form — set only for a single-Occurrence `CANCEL` (`RECURRENCE-ID`). */
  recurrenceId: string | null;
}

/**
 * The Series' own DATE-TIME convention (`calendars/materialiser.ts`'s doc
 * comment) read back into an `ICAL.Time`: all-day and floating values are
 * already a "UTC-labeled wall clock" — their UTC year/month/day/etc. fields
 * *are* the wall-clock components to write — while a zoned value is a real
 * instant that must be projected into `tzid`'s own wall clock first.
 */
function wallClockTime(date: Date, allDay: boolean, tzid: string | null): ICAL.Time {
  if (allDay) {
    return new ICAL.Time(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        isDate: true,
      },
      ICAL.Timezone.localTimezone,
    );
  }
  if (tzid) {
    const wall = DateTime.fromJSDate(date, { zone: tzid });
    return new ICAL.Time(
      {
        year: wall.year,
        month: wall.month,
        day: wall.day,
        hour: wall.hour,
        minute: wall.minute,
        second: wall.second,
        isDate: false,
      },
      ICAL.Timezone.localTimezone,
    );
  }
  return new ICAL.Time(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      isDate: false,
    },
    ICAL.Timezone.localTimezone,
  );
}

function addTimeProperty(
  vevent: ICAL.Component,
  name: string,
  date: Date,
  allDay: boolean,
  tzid: string | null,
): void {
  const property = vevent.updatePropertyWithValue(name, wallClockTime(date, allDay, tzid));
  if (!allDay && tzid) property.setParameter("tzid", tzid);
}

/** Builds the `METHOD:REQUEST`/`METHOD:CANCEL` `VCALENDAR` text `invitations/request-submit.ts` attaches to the outbound mail (RFC 6047). */
export function buildOrganizerIcs(input: OrganizerIcsInput): string {
  const vcalendar = new ICAL.Component("vcalendar");
  vcalendar.updatePropertyWithValue("prodid", "-//Wicket Mail//EN");
  vcalendar.updatePropertyWithValue("version", "2.0");
  vcalendar.updatePropertyWithValue("method", input.method);

  const vevent = new ICAL.Component("vevent");
  vevent.updatePropertyWithValue("uid", input.uid);
  vevent.updatePropertyWithValue("sequence", input.sequence);
  vevent.updatePropertyWithValue("dtstamp", ICAL.Time.now());

  const organizerProperty = vevent.updatePropertyWithValue(
    "organizer",
    `mailto:${input.organizer.address}`,
  );
  if (input.organizer.name) organizerProperty.setParameter("cn", input.organizer.name);

  addTimeProperty(vevent, "dtstart", input.dtstart, input.allDay, input.tzid);
  const end = new Date(input.dtstart.getTime() + input.durationMs);
  addTimeProperty(vevent, "dtend", end, input.allDay, input.tzid);

  if (input.summary) vevent.updatePropertyWithValue("summary", input.summary);
  if (input.description) vevent.updatePropertyWithValue("description", input.description);
  if (input.location) vevent.updatePropertyWithValue("location", input.location);

  for (const attendee of input.attendees) {
    // `addPropertyWithValue`, not `updatePropertyWithValue` — ATTENDEE is
    // multi-valued (one line per recipient); `update` would overwrite the
    // previous Attendee's line rather than adding a new one.
    const attendeeProperty = vevent.addPropertyWithValue("attendee", `mailto:${attendee.address}`);
    attendeeProperty.setParameter("role", "REQ-PARTICIPANT");
    attendeeProperty.setParameter("partstat", "NEEDS-ACTION");
    attendeeProperty.setParameter("rsvp", input.method === "REQUEST" ? "TRUE" : "FALSE");
    if (attendee.name) attendeeProperty.setParameter("cn", attendee.name);
  }

  for (const rrule of input.rrules) {
    vevent.addPropertyWithValue("rrule", ICAL.Recur.fromString(rrule));
  }
  for (const rdate of input.rdates) {
    vevent.addPropertyWithValue("rdate", wallClockTime(new Date(rdate), input.allDay, input.tzid));
  }
  for (const exdate of input.exdates) {
    vevent.addPropertyWithValue(
      "exdate",
      wallClockTime(new Date(exdate), input.allDay, input.tzid),
    );
  }

  if (input.recurrenceId) {
    const recurrenceProperty = vevent.updatePropertyWithValue(
      "recurrence-id",
      wallClockTime(new Date(input.recurrenceId), input.allDay, input.tzid),
    );
    if (!input.allDay && input.tzid) recurrenceProperty.setParameter("tzid", input.tzid);
  }

  if (input.method === "CANCEL") {
    vevent.updatePropertyWithValue("status", "CANCELLED");
  }

  vcalendar.addSubcomponent(vevent);
  return vcalendar.toString();
}
