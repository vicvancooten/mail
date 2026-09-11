import { type CalendarCapabilities, MAX_EVENT_REMINDERS, type ReminderDefault } from "@mail/shared";
import type {
  GoogleCalendarListEntry,
  GoogleCalendarMetadata,
  GoogleEventReminder,
} from "./client.js";

/**
 * A mirrored Calendar's deterministic id (#234) — the same "no lookup
 * before an upsert" reasoning `personalCalendarId` gives the Local
 * Calendar (`packages/shared/src/calendars.ts`), keyed instead on the pair
 * that actually identifies a mirrored row: the opaque `connectedAccountId`
 * string and Google's own `calendarId` (itself already globally unique per
 * account, e.g. the account's email for its primary calendar).
 */
export function googleCalendarRowId(connectedAccountId: string, googleCalendarId: string): string {
  return `gcal:${connectedAccountId}:${googleCalendarId}`;
}

/**
 * ADR-0025's capability flags, computed from Google's own `accessRole`
 * (ticket acceptance line: "capability flags computed from `accessRole`").
 * `recurrenceGrammar` is `"rfc5545"` for anything writable — Google's own
 * grammar is RFC 5545 `RRULE`s — and `"none"` for a read-only mirror, since
 * the Client should never offer a repeat option it cannot save back
 * (write-back itself is #237's; this only decides what the editor may try).
 */
export function capabilitiesFromAccessRole(
  accessRole: GoogleCalendarListEntry["accessRole"],
): CalendarCapabilities {
  const writable = accessRole === "owner" || accessRole === "writer";
  return {
    writable,
    historyBounded: false,
    invitesSentByUpstream: true,
    canSuppressInviteMail: false,
    recurrenceGrammar: writable ? "rfc5545" : "none",
    // Google's `reminders.overrides` documents no ceiling of its own — the
    // same cap a Local Calendar gets (#244, ADR-0028).
    perEventReminders: MAX_EVENT_REMINDERS,
    attachments: false,
    conferencing: false,
  };
}

export interface FoldedGoogleCalendar {
  name: string;
  timeZone: string;
  color: string;
  capabilities: CalendarCapabilities;
  reminderDefault: ReminderDefault;
}

/**
 * The Reminder Default's one-time seed for a fresh mirrored Calendar (#244,
 * ADR-0028: "a synced Calendar seeds its timed list from the upstream's
 * default where it has one, once"). Google's `defaultReminders` is one flat
 * list with no timed/all-day split of its own — folded onto `timed` only,
 * since Google's own default is what it uses for a plain timed Event; an
 * absent or empty list (a calendar the User has never customised defaults
 * on) leaves both lists empty rather than guessing at a Wicket-only policy
 * the ADR reserves for the Local Calendar alone.
 */
function reminderDefaultFrom(defaultReminders: GoogleEventReminder[] | undefined): ReminderDefault {
  const timed = (defaultReminders ?? []).map((reminder) => reminder.minutes);
  return { timed, allDay: [] };
}

/** A reasonable fallback when Google's own `colorId`/`backgroundColor` is absent — matches `DEFAULT_CALENDAR_COLOR` (`packages/shared/src/calendars.ts`) rather than inventing a second default. */
const FALLBACK_COLOR = "#4285F4";

/**
 * Folds one `CalendarList` entry (the User's own subscription: `accessRole`,
 * display overrides) together with its `Calendars` metadata (the calendar's
 * own `timeZone`, canonical `summary`) into the one Calendar row the ticket
 * asks for — "`CalendarList` and `Calendars` folding into one Calendar row."
 */
export function foldGoogleCalendar(
  entry: GoogleCalendarListEntry,
  metadata: GoogleCalendarMetadata,
): FoldedGoogleCalendar {
  return {
    name: entry.summary ?? metadata.summary ?? entry.id,
    timeZone: metadata.timeZone,
    color: entry.backgroundColor ?? FALLBACK_COLOR,
    capabilities: capabilitiesFromAccessRole(entry.accessRole),
    reminderDefault: reminderDefaultFrom(entry.defaultReminders),
  };
}
