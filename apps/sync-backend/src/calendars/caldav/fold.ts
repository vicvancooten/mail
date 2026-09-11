import {
  type CalendarCapabilities,
  DEFAULT_CALENDAR_COLOR,
  MAX_EVENT_REMINDERS,
} from "@mail/shared";
import type { CaldavCalendarEntry } from "./client.js";

/**
 * A mirrored CalDAV Calendar's deterministic id (#247) — `google/fold.ts
 * #googleCalendarRowId`'s own shape, keyed on the opaque `connectedAccountId`
 * and the collection's own href (already globally unique per account: two
 * calendars never share a URL).
 */
export function caldavCalendarRowId(connectedAccountId: string, href: string): string {
  return `caldav:${connectedAccountId}:${href}`;
}

export const CALDAV_ROW_ID_PREFIX = "caldav:";

/** Recovers a mirrored row's own href from its deterministic id — `poll-loop.ts`/`outbox-processor.ts`'s own "no second stored column" idiom, `google/poll-loop.ts`'s own comment on the same trick. */
export function caldavHrefFromRowId(id: string, connectedAccountId: string): string {
  return id.slice(`${CALDAV_ROW_ID_PREFIX}${connectedAccountId}:`.length);
}

/**
 * ADR-0025's capability flags, computed from `current-user-privilege-set`
 * (this ticket's own acceptance line: "`writable` is computed from
 * `current-user-privilege-set`, and drives `mirrored`'s default").
 * `recurrenceGrammar` is `"rfc5545"` for anything writable — CalDAV's own
 * grammar *is* RFC 5545 — and `"none"` for a read-only mirror, the same
 * "the Client should never offer a repeat option it cannot save back"
 * reasoning `google/fold.ts#capabilitiesFromAccessRole` already gives.
 */
export function capabilitiesFromCaldavEntry(entry: CaldavCalendarEntry): CalendarCapabilities {
  return {
    writable: entry.writable,
    historyBounded: false,
    invitesSentByUpstream: entry.invitesSentByUpstream,
    // A self-scheduled (no `calendar-auto-schedule`) Calendar reuses the
    // Local organiser's own iMIP mail (#242) — that path always lets the
    // User choose whether to notify, the same "Send invitations" toggle a
    // scheduling-aware server's own suppression covers, so this is `true`
    // either way; `outbox-processor.ts` simply has nothing to suppress on a
    // self-scheduled Calendar (RFC 6638 never runs there at all).
    canSuppressInviteMail: true,
    recurrenceGrammar: entry.writable ? "rfc5545" : "none",
    perEventReminders: MAX_EVENT_REMINDERS,
    attachments: false,
    conferencing: false,
  };
}

export interface FoldedCaldavCalendar {
  name: string;
  timeZone: string;
  color: string;
  capabilities: CalendarCapabilities;
}

/** Folds one home-set PROPFIND entry into the shape `calendar-list-sync.ts` upserts — `google/fold.ts#foldGoogleCalendar`'s own shape, one source rather than two (CalDAV has no separate "list" vs. "metadata" resource the way Google splits `CalendarList`/`Calendars`). */
export function foldCaldavCalendar(entry: CaldavCalendarEntry): FoldedCaldavCalendar {
  return {
    name: entry.displayName,
    timeZone: entry.timeZone ?? "UTC",
    color: entry.color ?? DEFAULT_CALENDAR_COLOR,
    capabilities: capabilitiesFromCaldavEntry(entry),
  };
}
