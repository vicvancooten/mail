import type { CalendarCapabilities } from "@mail/shared";
import type { GraphCalendarListEntry } from "./client.js";

/**
 * A mirrored Graph Calendar's deterministic id (#248) — `google/fold.ts
 * #googleCalendarRowId`'s own shape, keyed on the pair that identifies a
 * mirrored row: the opaque `connectedAccountId` and Graph's own `calendar.id`.
 */
export function graphCalendarRowId(connectedAccountId: string, graphCalendarId: string): string {
  return `gcal-ms:${connectedAccountId}:${graphCalendarId}`;
}

/**
 * ADR-0025's capability flags, computed from Graph's own `canEdit` (this
 * ticket's own acceptance line: "`canEdit` is the write flag"). `historyBounded`
 * is `true` for **every** Graph Calendar, unconditionally — unlike Google's
 * own `false` — because it is `calendarView/delta`'s own date-range-scoped
 * nature that makes Graph the windowed mirror (ADR-0025's own bend), not
 * anything per-calendar. `canSuppressInviteMail: false` (no `sendUpdates`-style
 * knob exists on a Graph event write; `event: cancel` always notifies).
 * `recurrenceGrammar` is `"graph"` for anything writable — never `"rfc5545"` —
 * so the editor knows to translate through `event-body.ts#toGraphRecurrence`'s
 * narrower vocabulary rather than RFC 5545's full one.
 */
export function capabilitiesFromCanEdit(canEdit: boolean): CalendarCapabilities {
  return {
    writable: canEdit,
    historyBounded: true,
    invitesSentByUpstream: true,
    canSuppressInviteMail: false,
    recurrenceGrammar: canEdit ? "graph" : "none",
    // Graph's `reminderMinutesBeforeStart` is a single slot, not a list
    // (#244, ADR-0028's own "Graph: one") — the new count model's `1`.
    perEventReminders: 1,
    attachments: false,
    conferencing: false,
  };
}

export interface FoldedGraphCalendar {
  name: string;
  color: string;
  capabilities: CalendarCapabilities;
}

/** Matches `DEFAULT_CALENDAR_COLOR`/Google's own fallback (`google/fold.ts`) rather than inventing a third default. */
const FALLBACK_COLOR = "#4285F4";

/**
 * Folds one `GET /me/calendars` entry into the one Calendar row this ticket
 * asks for — unlike Google, there is only one call to fold (Graph's own
 * `calendar` resource already carries `name`/`canEdit`/`hexColor` together,
 * this ticket's own acceptance line: "Time zone comes from the mailbox-wide
 * `mailboxSettings.timeZone`" is the one field this resource can't answer,
 * supplied by the caller instead — see `calendar-list-sync.ts`).
 */
export function foldGraphCalendar(entry: GraphCalendarListEntry): FoldedGraphCalendar {
  return {
    name: entry.name,
    // Graph's own docs describe `hexColor` as "three hexadecimal values" with
    // no worked example showing whether a leading `#` is included — assumed
    // absent (prepended here) pending a live account to confirm; a wrong
    // guess here is cosmetic only (a mis-rendered swatch), never a write.
    color: entry.hexColor && entry.hexColor.length > 0 ? `#${entry.hexColor}` : FALLBACK_COLOR,
    capabilities: capabilitiesFromCanEdit(entry.canEdit),
  };
}
