import { z } from "zod";
import {
  MAX_EVENT_REMINDERS,
  perEventRemindersSchema,
  reminderDefaultSchema,
} from "./reminders.js";

/**
 * `Calendar` (#229, CONTEXT.md: "one named collection of Events with exactly
 * one Origin"), the wire on which the whole Calendar App stands. Replicates
 * **whole** — a User has at most a handful of Calendars, the same "no
 * windowing" posture `labelSchema`/`noteSchema` already take — and is
 * **User-scoped** on this line today: `origin.type === "connectedAccount"`
 * is declared below because ADR-0025 amends ADR-0011 to add it, but nothing
 * yet produces a mirrored row (#234, "Google Calendar mirrors a Calendar",
 * picks that up) and the Connected Account model itself (#200) has not
 * landed on this branch's ancestry — see this ticket's closing comment.
 */

/**
 * Where a Calendar comes from (CONTEXT.md's Origin entry): `Local` — this
 * instance is the authority, never synced upstream — or a Connected
 * Account's own mirrored calendar. `connectedAccountId` rides inside the
 * `connectedAccount` variant rather than as a sibling nullable field so the
 * two are mutually exclusive by construction, not by convention.
 */
export const calendarOriginSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local") }),
  z.object({ type: z.literal("connectedAccount"), connectedAccountId: z.string() }),
]);
export type CalendarOrigin = z.infer<typeof calendarOriginSchema>;

export const LOCAL_CALENDAR_ORIGIN: CalendarOrigin = { type: "local" };

/**
 * Whether an Event can be offered a Move from one Origin to another (#238's
 * own acceptance line: "Same-Origin moves and moves to a Local Calendar are
 * offered; cross-Connected-Account moves are hidden, not disabled") —
 * `EventEditorPopover.tsx`'s move-destination picker filters on this, and
 * `series-store.ts#moveSeries` re-checks it server-side as defense in depth,
 * the same "the picker never offers it, this is belt and suspenders" posture
 * `updateCalendarDetails`'s own `capabilities.writable` guard already has.
 * `false` only when both Origins are a Connected Account and it isn't the
 * *same* one — no upstream lets a calendar object change container while
 * keeping identity, so a cross-account Move would mean deleting from one
 * provider and creating in another with a new UID, which attendees read as a
 * cancellation followed by a new invitation.
 */
export function canMoveBetweenOrigins(from: CalendarOrigin, to: CalendarOrigin): boolean {
  if (from.type !== "connectedAccount" || to.type !== "connectedAccount") return true;
  return from.connectedAccountId === to.connectedAccountId;
}

/**
 * What an Origin's backend can actually do with a Calendar (ADR-0025:
 * "Capabilities per Calendar, computed by the adapter and read by the
 * Client to hide what would fail rather than roll it back"). Shared between
 * the (future) adapters, which compute it, and the editor, which reads it —
 * one type rather than each side inventing its own shape. `recurrenceGrammar`
 * is `"none"` for a backend the Client should never offer a repeat option
 * on; `"rfc5545"` is every Local Calendar and most upstreams, `"graph"`
 * names Microsoft Graph's strict subset (ADR-0025).
 */
export const calendarCapabilitiesSchema = z.object({
  writable: z.boolean(),
  historyBounded: z.boolean(),
  invitesSentByUpstream: z.boolean(),
  canSuppressInviteMail: z.boolean(),
  recurrenceGrammar: z.enum(["none", "rfc5545", "graph"]),
  /** #244's own body: "`perEventReminders` — which becomes a count, not a flag" (`reminders.ts#perEventRemindersSchema`'s own doc comment). */
  perEventReminders: perEventRemindersSchema,
  attachments: z.boolean(),
  conferencing: z.boolean(),
});
export type CalendarCapabilities = z.infer<typeof calendarCapabilitiesSchema>;

/**
 * A Local Calendar's capabilities (#229's demoable slice): Wicket is the
 * organiser's authority, so everything it can express it can also enforce.
 * Attachments/conferencing are v1 gaps, not upstream limits — additive once
 * the editor grows either.
 */
export const LOCAL_CALENDAR_CAPABILITIES: CalendarCapabilities = {
  writable: true,
  historyBounded: false,
  invitesSentByUpstream: false,
  canSuppressInviteMail: false,
  recurrenceGrammar: "rfc5545",
  perEventReminders: MAX_EVENT_REMINDERS,
  attachments: false,
  conferencing: false,
};

/** A reasonable default for a freshly-created Calendar's colour swatch — the User's own choice from then on, never read from an upstream. */
export const DEFAULT_CALENDAR_COLOR = "#4285F4";

/** The one Local Calendar every User gets from first use of the App (CONTEXT.md's Calendar entry, this ticket's acceptance line). */
export const PERSONAL_CALENDAR_NAME = "Personal";

/**
 * A Calendar's id: deterministic for the one Calendar this ticket ever
 * creates server-side — the Personal Calendar — the same `labelId`-style
 * reasoning (`labels.ts`): `sync/calendars.ts#ensurePersonalCalendar` can
 * `onConflictDoNothing` against it with no lookup first, and it never
 * collides across Users. A future mirrored Calendar's id is minted per
 * upstream row instead (#234) — this helper is Personal Calendar's alone.
 */
export function personalCalendarId(userId: string): string {
  return `${userId}:personal`;
}

/**
 * What unmirroring a Calendar discards (#235's own acceptance line:
 * "Series, Overrides, Occurrences, its Reminder Due rows and its outbox
 * entries"). Only `events` (Occurrences) is populated today — Series,
 * Overrides, Reminder Due rows and the write-back outbox are #230's/#237's
 * tables, none of which exist on this branch's ancestry yet. Additive: a
 * future table adds a field here, not a reshape.
 */
export const calendarMirrorImpactSchema = z.object({
  events: z.number().int().nonnegative(),
});
export type CalendarMirrorImpact = z.infer<typeof calendarMirrorImpactSchema>;

/** `GET /calendars/:id/unmirror-impact` — the confirm dialog's counts, before anything is discarded. */
export const unmirrorImpactResponseSchema = z.object({ discarded: calendarMirrorImpactSchema });
export type UnmirrorImpactResponse = z.infer<typeof unmirrorImpactResponseSchema>;

export const calendarSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** IANA zone name — the upstream's own for a mirrored Calendar, the User's Home Time Zone (#189) for a Local one. */
  timeZone: z.string(),
  origin: calendarOriginSchema,
  /** Hex swatch. The User's own choice, never read from or written to an upstream (CONTEXT.md). */
  color: z.string(),
  /** The one Calendar across every Origin that new Events default onto (CONTEXT.md). Exactly one `true` row per User. */
  isDefault: z.boolean(),
  /**
   * The Mail Account whose address organises this Calendar's Events and
   * receives its Invitations (CONTEXT.md's Calendar entry) — `null` while
   * the User has no Mail Account yet. Several Local Calendars may share one.
   * Always `null` for a mirrored Calendar, whose Organiser is the upstream's
   * own concern.
   */
  mailAccountId: z.string().nullable(),
  /**
   * Whether this Calendar's Events actually sync into the App (#235,
   * "`mirrored` per Calendar and the Facet's checklist") — a Connected
   * Account's Facet lists every upstream calendar it sees, and the User
   * checks the ones they want. Always `true` for a Local Calendar: there is
   * no checklist to turn it off from.
   */
  mirrored: z.boolean(),
  capabilities: calendarCapabilitiesSchema,
  /**
   * Wicket rings this Calendar's Reminders (ADR-0028) — a User-scoped,
   * synced on/off, defaulting `true` for every Origin (#244's own acceptance
   * line), shown both here and, again, on `CalendarSettingsSheet.tsx`. Never
   * mirrored: gates only whether Wicket's own #245 loop *records* a due
   * Reminder, which the upstream never hears about either way.
   */
  remindersEnabled: z.boolean(),
  /** ADR-0028's Reminder Default — see `reminders.ts#reminderDefaultSchema`'s own doc comment. */
  reminderDefault: reminderDefaultSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Calendar = z.infer<typeof calendarSchema>;

/**
 * `POST /calendars/:id/unmirror` — not an Optimistic Action (#235's own
 * acceptance line: "Not an Optimistic Action"), so unlike a queued
 * `UserMutationIntent` this is a plain request/response: the Calendar's
 * `mirrored` flip and its discarded counts land in the same response, and
 * the Client never predicts either ahead of the round trip.
 */
export const unmirrorCalendarResponseSchema = z.object({
  calendar: calendarSchema,
  discarded: calendarMirrorImpactSchema,
});
export type UnmirrorCalendarResponse = z.infer<typeof unmirrorCalendarResponseSchema>;

/** `POST /calendars/:id/mirror` — re-mirroring, the checklist's other direction. */
export const mirrorCalendarResponseSchema = z.object({ calendar: calendarSchema });
export type MirrorCalendarResponse = z.infer<typeof mirrorCalendarResponseSchema>;
