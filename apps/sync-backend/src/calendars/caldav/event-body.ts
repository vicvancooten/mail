import type { SeriesAttendee } from "@mail/shared";
import ICAL from "ical.js";
import { DateTime } from "luxon";

/**
 * Builds and parses the raw RFC 5545 `.ics` body a CalDAV `PUT`/`REPORT`
 * carries (#247) — `invitations/organizer-ics.ts`'s own wall-clock
 * convention for the write side (`wallClockTime` duplicated here rather than
 * imported: that module builds an iTIP `METHOD:REQUEST` message, this one a
 * plain stored calendar object, different enough documents that sharing one
 * helper across both would blur what each actually needs), and `invitations/
 * ical.ts`'s own `ICAL.Time`-reading idiom for the read side.
 */

interface SeriesForCaldavBody {
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
  sequence: number;
}

/** The Series' own DATE-TIME convention (`calendars/materialiser.ts`'s doc comment) read into an `ICAL.Time` — `organizer-ics.ts#wallClockTime`'s own logic. */
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

/**
 * Builds the `VCALENDAR`/`VEVENT` body one outbox push `PUT`s (#247). Unlike
 * `buildOrganizerIcs` this is never an iTIP message (no `METHOD`) — it's the
 * stored object itself, the same "what does the calendar collection now
 * hold" question `google/event-body.ts#buildGoogleEventBody` answers for
 * Google's own JSON resource.
 *
 * Series-body-only, same scope line `google/event-body.ts` draws: an
 * Override does not ride this body, only the Series' own master fields.
 */
export function buildCaldavEventBody(uid: string, seriesRow: SeriesForCaldavBody): string {
  const vcalendar = new ICAL.Component("vcalendar");
  vcalendar.updatePropertyWithValue("prodid", "-//Wicket Mail//EN");
  vcalendar.updatePropertyWithValue("version", "2.0");

  const vevent = new ICAL.Component("vevent");
  vevent.updatePropertyWithValue("uid", uid);
  vevent.updatePropertyWithValue("sequence", seriesRow.sequence);
  vevent.updatePropertyWithValue("dtstamp", ICAL.Time.now());

  addTimeProperty(vevent, "dtstart", seriesRow.dtstart, seriesRow.allDay, seriesRow.tzid);
  const end = new Date(seriesRow.dtstart.getTime() + seriesRow.durationMs);
  addTimeProperty(vevent, "dtend", end, seriesRow.allDay, seriesRow.tzid);

  vevent.updatePropertyWithValue("summary", seriesRow.title);
  if (seriesRow.description) vevent.updatePropertyWithValue("description", seriesRow.description);
  if (seriesRow.location) vevent.updatePropertyWithValue("location", seriesRow.location);
  vevent.updatePropertyWithValue("transp", seriesRow.transparency.toUpperCase());

  for (const attendee of seriesRow.attendees) {
    const attendeeProperty = vevent.addPropertyWithValue("attendee", `mailto:${attendee.email}`);
    attendeeProperty.setParameter("partstat", partstatFor(attendee.responseStatus));
    if (attendee.name) attendeeProperty.setParameter("cn", attendee.name);
  }

  for (const rrule of seriesRow.rrules) {
    vevent.addPropertyWithValue("rrule", ICAL.Recur.fromString(rrule));
  }
  for (const rdate of seriesRow.rdates) {
    vevent.addPropertyWithValue(
      "rdate",
      wallClockTime(new Date(rdate), seriesRow.allDay, seriesRow.tzid),
    );
  }
  for (const exdate of seriesRow.exdates) {
    vevent.addPropertyWithValue(
      "exdate",
      wallClockTime(new Date(exdate), seriesRow.allDay, seriesRow.tzid),
    );
  }

  vcalendar.addSubcomponent(vevent);
  return vcalendar.toString();
}

function partstatFor(responseStatus: SeriesAttendee["responseStatus"]): string {
  switch (responseStatus) {
    case "accepted":
      return "ACCEPTED";
    case "declined":
      return "DECLINED";
    case "tentative":
      return "TENTATIVE";
    default:
      return "NEEDS-ACTION";
  }
}

/** `STATUS:CANCELLED` (this ticket's own conditional-write acceptance line, `outbox-processor.ts`'s own `cancel`/`restore` operations) — a status-flip re-`PUT` of an already-fetched body, never a fresh build. */
export function withCancelledStatus(icsBody: string): string {
  const jCal = ICAL.parse(icsBody);
  const component = new ICAL.Component(jCal);
  for (const vevent of component.getAllSubcomponents("vevent")) {
    vevent.updatePropertyWithValue("status", "CANCELLED");
  }
  return component.toString();
}

/** `STATUS:CONFIRMED` — `withCancelledStatus`'s own mirror for `restore`. */
export function withConfirmedStatus(icsBody: string): string {
  const jCal = ICAL.parse(icsBody);
  const component = new ICAL.Component(jCal);
  for (const vevent of component.getAllSubcomponents("vevent")) {
    vevent.removeProperty("status");
  }
  return component.toString();
}

export interface ParsedCaldavInstance {
  uid: string;
  /** `null` for the master instance; the `RECURRENCE-ID` value for an explicit override VEVENT within the same object. */
  recurrenceId: Date | null;
  sequence: number;
  summary: string | null;
  description: string | null;
  location: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  status: "confirmed" | "cancelled";
  transparency: "opaque" | "transparent";
}

/**
 * Reads one `calendar-multiget`/initial-sync `.ics` resource into its
 * `VEVENT`s (#247) — `invitations/ical.ts#parseIcalInvitations`'s own
 * `ICAL.Time`-reading idiom, minus the iTIP (`METHOD`/organiser/attendee)
 * fields that module reads and this one has no use for.
 *
 * **Recurrence expansion is out of scope** (this ticket's closing comment):
 * a recurring master `VEVENT` (one carrying an `RRULE`) is ingested as a
 * single Occurrence at its own `DTSTART`, exactly like a singleton event —
 * unlike Google (`singleEvents=true`) and Graph (`calendarView`'s own
 * server-side expansion), CalDAV never expands recurrence server-side, and
 * doing so correctly client-side (recurring-instance windowing against
 * `EXDATE`/`RDATE`/timezone rules) is real additional surface a live server
 * is needed to verify against. Any *explicit* override `VEVENT` already
 * present in the object (its own `RECURRENCE-ID`) is still ingested as its
 * own Occurrence row, the same way Google/Graph's own server-side expansion
 * already surfaces one.
 */
export function parseCaldavObject(icsData: string): ParsedCaldavInstance[] {
  let component: ICAL.Component;
  try {
    const jCal = ICAL.parse(icsData);
    component = new ICAL.Component(jCal);
  } catch {
    return [];
  }
  if (component.name !== "vcalendar") return [];

  const out: ParsedCaldavInstance[] = [];
  for (const vevent of component.getAllSubcomponents("vevent")) {
    const parsed = parseVevent(vevent);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseVevent(vevent: ICAL.Component): ParsedCaldavInstance | null {
  const uid = firstStringValue(vevent, "uid");
  if (!uid) return null;

  const dtstartProp = vevent.getFirstProperty("dtstart");
  const dtstartValue = dtstartProp?.getFirstValue();
  if (!(dtstartValue instanceof ICAL.Time)) return null;

  const recurrenceIdProp = vevent.getFirstProperty("recurrence-id");
  const recurrenceIdValue = recurrenceIdProp?.getFirstValue();
  const recurrenceId = recurrenceIdValue instanceof ICAL.Time ? recurrenceIdValue.toJSDate() : null;

  const dtendProp = vevent.getFirstProperty("dtend");
  const dtendValue = dtendProp?.getFirstValue();
  const durationProp = vevent.getFirstPropertyValue("duration");
  const start = dtstartValue.toJSDate();
  const end =
    dtendValue instanceof ICAL.Time
      ? dtendValue.toJSDate()
      : durationProp instanceof ICAL.Duration
        ? new Date(start.getTime() + durationProp.toSeconds() * 1000)
        : start;

  const statusRaw = firstStringValue(vevent, "status");
  const transpRaw = firstStringValue(vevent, "transp");
  const sequenceRaw = vevent.getFirstPropertyValue("sequence");
  const sequence =
    typeof sequenceRaw === "number"
      ? sequenceRaw
      : typeof sequenceRaw === "string"
        ? Number.parseInt(sequenceRaw, 10)
        : 0;

  return {
    uid,
    recurrenceId,
    sequence: Number.isFinite(sequence) ? sequence : 0,
    summary: firstStringValue(vevent, "summary"),
    description: firstStringValue(vevent, "description"),
    location: firstStringValue(vevent, "location"),
    start,
    end,
    allDay: dtstartValue.isDate,
    status: statusRaw?.toUpperCase() === "CANCELLED" ? "cancelled" : "confirmed",
    transparency: transpRaw?.toUpperCase() === "TRANSPARENT" ? "transparent" : "opaque",
  };
}

function firstStringValue(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" && value.length > 0 ? value : null;
}
