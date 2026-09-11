import ICAL from "ical.js";
import type { InvitationParticipant } from "../db/schema.js";

/**
 * The iMIP `REPLY` an Answer on a Local Calendar sends (#241, ADR-0027) —
 * `invitations/ical.ts`'s parsing run in reverse: RFC 6047's `REPLY` needs
 * only `UID`, `SEQUENCE`, `DTSTAMP`, `ORGANIZER` and one `ATTENDEE` line
 * carrying this Answer's `PARTSTAT`, so this builds exactly that rather than
 * a full `VEVENT` mirror (no `DTSTART`/`DTEND`/`RRULE` — the organiser
 * already has those from its own `REQUEST`).
 */

export type ResponseStatus = "accepted" | "declined" | "tentative";

const PARTSTAT: Record<ResponseStatus, string> = {
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
};

export interface ReplyIcsInput {
  uid: string;
  /** The `SEQUENCE` of the `REQUEST` revision being answered — RFC 5546: a `REPLY` echoes it back, never bumping it. */
  sequence: number;
  organizer: InvitationParticipant | null;
  /** The invited address verbatim (ADR-0027: "`ATTENDEE` is the invited address verbatim, Alias included"). */
  attendeeAddress: string;
  attendeeName: string | null;
  responseStatus: ResponseStatus;
  /** The Event's own title, carried as `SUMMARY` only for a human reading the raw `.ics` — organisers key off `PARTSTAT`, not this. */
  summary: string | null;
}

/** Builds the `METHOD:REPLY` `VCALENDAR` text `invitations/reply-submit.ts` attaches to the outbound mail (`icalEvent`, RFC 6047). */
export function buildReplyIcs(input: ReplyIcsInput): string {
  const vcalendar = new ICAL.Component("vcalendar");
  vcalendar.updatePropertyWithValue("prodid", "-//Wicket Mail//EN");
  vcalendar.updatePropertyWithValue("version", "2.0");
  vcalendar.updatePropertyWithValue("method", "REPLY");

  const vevent = new ICAL.Component("vevent");
  vevent.updatePropertyWithValue("uid", input.uid);
  vevent.updatePropertyWithValue("sequence", input.sequence);
  vevent.updatePropertyWithValue("dtstamp", ICAL.Time.now());
  if (input.summary) vevent.updatePropertyWithValue("summary", input.summary);

  if (input.organizer) {
    const organizerProperty = vevent.updatePropertyWithValue(
      "organizer",
      `mailto:${input.organizer.address}`,
    );
    if (input.organizer.name) organizerProperty.setParameter("cn", input.organizer.name);
  }

  const attendeeProperty = vevent.updatePropertyWithValue(
    "attendee",
    `mailto:${input.attendeeAddress}`,
  );
  attendeeProperty.setParameter("partstat", PARTSTAT[input.responseStatus]);
  if (input.attendeeName) attendeeProperty.setParameter("cn", input.attendeeName);

  vcalendar.addSubcomponent(vevent);
  return vcalendar.toString();
}
