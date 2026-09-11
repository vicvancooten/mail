import ICAL from "ical.js";
import type { InvitationParticipant, InvitationVevent } from "../db/schema.js";
import { icalTimeToUtcDate } from "../ical-time.js";

/**
 * Reads a `text/calendar` part into zero or more parsed Invitations (#239,
 * ADR-0027) — one per `VEVENT` the component carries, which is almost always
 * one, but RFC 5545 allows several (a `REQUEST` for a whole Series plus its
 * `RECURRENCE-ID` exceptions in one `.ics`).
 *
 * The **inner `METHOD` wins over a disagreeing `Content-Type` parameter**
 * (this ticket's acceptance line) by construction: this module never looks
 * at the Content-Type `method=` parameter at all, only the component's own
 * `METHOD` property, which is the "inner" one.
 */

export type IcalMethod = "REQUEST" | "REPLY" | "CANCEL";

export interface ParsedInvitation {
  method: IcalMethod;
  uid: string;
  /** `''` for "no `RECURRENCE-ID`" — see `db/schema.ts#invitations`' own doc comment. */
  recurrenceId: string;
  sequence: number;
  dtstamp: Date;
  organizer: InvitationParticipant | null;
  attendees: InvitationParticipant[];
  vevent: InvitationVevent;
}

const SUPPORTED_METHODS: ReadonlySet<string> = new Set(["REQUEST", "REPLY", "CANCEL"]);

/** RFC 5546 `METHOD` → this ticket's three-way `kind` bucket. */
export function mapMethodToKind(method: string): "request" | "answer" | "cancellation" | null {
  switch (method) {
    case "REQUEST":
      return "request";
    case "REPLY":
      return "answer";
    case "CANCEL":
      return "cancellation";
    default:
      // PUBLISH, COUNTER, DECLINECOUNTER, REFRESH, ADD: RFC 5546 methods
      // with no clean fit in this ticket's three-way `kind` (deliberate
      // scope decision, #239's closing report) — not stored.
      return null;
  }
}

/**
 * Parses one `text/calendar` part's text into its Invitations. Returns an
 * empty array for anything that doesn't parse as a `VCALENDAR` with a
 * `METHOD` this ticket understands, or that carries no `VEVENT` — malformed
 * or foreign calendar mail degrades to "no Invitation found", never a thrown
 * error (arriving mail is adversarial input).
 */
export function parseIcalInvitations(icsText: string): ParsedInvitation[] {
  let component: ICAL.Component;
  try {
    const jCal = ICAL.parse(icsText);
    component = new ICAL.Component(jCal);
  } catch {
    return [];
  }
  if (component.name !== "vcalendar") return [];

  const rawMethod = component.getFirstPropertyValue("method");
  const method = typeof rawMethod === "string" ? rawMethod.toUpperCase() : null;
  if (!method || !SUPPORTED_METHODS.has(method)) return [];

  const out: ParsedInvitation[] = [];
  for (const vevent of component.getAllSubcomponents("vevent")) {
    const parsed = parseVevent(vevent, method as IcalMethod);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseVevent(vevent: ICAL.Component, method: IcalMethod): ParsedInvitation | null {
  const uid = firstStringValue(vevent, "uid");
  if (!uid) return null; // RFC 5545 requires it; nothing to key a row on without it.

  const recurrenceId = readTimeProperty(vevent, "recurrence-id");
  const dtstamp = readTimeProperty(vevent, "dtstamp") ?? readTimeProperty(vevent, "dtstart");
  const sequenceRaw = vevent.getFirstPropertyValue("sequence");
  const sequence =
    typeof sequenceRaw === "number"
      ? sequenceRaw
      : typeof sequenceRaw === "string"
        ? Number.parseInt(sequenceRaw, 10)
        : 0;

  const dtstart = readTimeProperty(vevent, "dtstart");
  const dtend = readTimeProperty(vevent, "dtend");
  const statusRaw = firstStringValue(vevent, "status");

  return {
    method,
    uid,
    recurrenceId: recurrenceId
      ? icalTimeToUtcDate(recurrenceId.time, recurrenceId.tzid).toISOString()
      : "",
    sequence: Number.isFinite(sequence) ? sequence : 0,
    dtstamp: dtstamp ? icalTimeToUtcDate(dtstamp.time, dtstamp.tzid) : new Date(),
    organizer: readParticipant(vevent, "organizer"),
    attendees: vevent
      .getAllProperties("attendee")
      .map((property) => readParticipantFromProperty(property))
      .filter((participant): participant is InvitationParticipant => participant !== null),
    vevent: {
      title: firstStringValue(vevent, "summary"),
      description: firstStringValue(vevent, "description"),
      location: firstStringValue(vevent, "location"),
      start: dtstart ? icalTimeToUtcDate(dtstart.time, dtstart.tzid).toISOString() : null,
      end: dtend ? icalTimeToUtcDate(dtend.time, dtend.tzid).toISOString() : null,
      allDay: dtstart?.time.isDate ?? false,
      tzid: dtstart?.tzid ?? null,
      status: statusRaw ? statusRaw.toUpperCase() : null,
    },
  };
}

function firstStringValue(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readTimeProperty(
  component: ICAL.Component,
  name: string,
): { time: ICAL.Time; tzid: string | null } | null {
  const property = component.getFirstProperty(name);
  if (!property) return null;
  const value = property.getFirstValue();
  if (!(value instanceof ICAL.Time)) return null;
  const tzid = property.getParameter("tzid");
  return { time: value, tzid: typeof tzid === "string" ? tzid : null };
}

function readParticipant(component: ICAL.Component, name: string): InvitationParticipant | null {
  const property = component.getFirstProperty(name);
  return property ? readParticipantFromProperty(property) : null;
}

/** `mailto:` is the only `CAL-ADDRESS` form iMIP mail ever carries in practice — a `cid`/`urn` organiser or attendee has nothing this ticket can address, and is skipped rather than stored malformed. */
function readParticipantFromProperty(property: ICAL.Property): InvitationParticipant | null {
  const value = property.getFirstValue();
  if (typeof value !== "string") return null;
  const address = value.replace(/^mailto:/i, "").trim();
  if (!address) return null;

  const cn = property.getParameter("cn");
  const role = property.getParameter("role");
  const partstat = property.getParameter("partstat");
  return {
    address,
    name: typeof cn === "string" && cn.length > 0 ? cn : null,
    role: typeof role === "string" && role.length > 0 ? role : null,
    partstat: typeof partstat === "string" && partstat.length > 0 ? partstat : null,
  };
}
