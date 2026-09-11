import { z } from "zod";
import { eventReminderSchema } from "./reminders.js";

/**
 * `Series` (#230, ADR-0025: "Series, Occurrence, Override are the storage
 * vocabulary"): the RFC 5545 body behind the Occurrence rows the `Event`
 * collection ships (`events.ts`). Recurrence is `rrules`/`rdates`/`exdates`
 * strings, not a structured object — two of the three sync backends ADR-0025
 * targets speak RFC 5545 natively, `rrule` (the materialiser's expansion
 * engine, `calendars/materialiser.ts`) consumes an RRULE string directly, and
 * iMIP needs it verbatim. A non-recurring Event is a Series with `rrules: []`
 * and, once materialised, exactly one Occurrence — one shape for everything
 * (this ticket's own body).
 *
 * Deliberately **not** an ADR-0011 collection: it carries no `syncRev` and
 * never rides `POST /sync` — "the Series body is an on-demand fetch, not
 * part of the `Event` delta" (this ticket's acceptance line), the same way a
 * mail Message body is (`routes/messages.ts`). `routes/calendars.ts` is the
 * one reader.
 */
export const seriesAttendeeSchema = z.object({
  email: z.string(),
  name: z.string().nullable(),
  responseStatus: z.enum(["needsAction", "accepted", "declined", "tentative"]),
});
export type SeriesAttendee = z.infer<typeof seriesAttendeeSchema>;

/**
 * The RFC 5545 DATE-TIME form a Series' times are stored in (ADR-0025:
 * "Timed Events are `{ instant, tzid }`; all-day are exclusive-end date
 * pairs with no zone; floating ship as wall clock plus a flag"). Exactly one
 * of `allDay`/`floating` is ever `true`; `tzid` is set only for the plain
 * timed case (`allDay: false, floating: false`) — see `series.ts`'s own
 * `dtstart`/`rdates`/`exdates` doc comment for the on-wire storage
 * convention each of the three implies.
 */
export const seriesSchema = z.object({
  id: z.string(),
  userId: z.string(),
  calendarId: z.string(),
  /** `<seriesId>@<instance host>` for a Wicket-created Series (this ticket's acceptance line); an upstream's own UID otherwise. */
  uid: z.string(),
  /** Incremented by Wicket only on Local Calendars, where the Sync Backend is the organiser's authority (ADR-0025); read-only elsewhere. */
  sequence: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  allDay: z.boolean(),
  floating: z.boolean(),
  /** IANA zone name, set only when `allDay` and `floating` are both `false`. */
  tzid: z.string().nullable(),
  /** The first occurrence's own start — see `materialiser.ts` for how later occurrences derive from it plus `rrules`/`rdates`. */
  dtstart: z.iso.datetime(),
  /** Every occurrence's wall-clock duration in milliseconds — RFC 5545's DTEND is always DTSTART-relative per instance, never stored separately. */
  durationMs: z.number().int().nonnegative(),
  /** RFC 5545 RRULE value strings (e.g. `"FREQ=WEEKLY;BYDAY=MO"`), no `RRULE:` prefix. */
  rrules: z.array(z.string()),
  /** RFC 5545 date-time strings, in this Series' own DATE-TIME form, adding one-off instances beyond what `rrules` generates. */
  rdates: z.array(z.string()),
  /**
   * RFC 5545 date-time strings removing instances from the recurrence set.
   * "A cancelled Occurrence is an `exdate` and nothing more" (this ticket's
   * acceptance line) — there is no separate cancellation Override.
   */
  exdates: z.array(z.string()),
  transparency: z.enum(["opaque", "transparent"]),
  attendees: z.array(seriesAttendeeSchema),
  /**
   * Up to `MAX_EVENT_REMINDERS`, capped in practice by the owning Calendar's
   * `perEventReminders` (#244, ADR-0028) — `reminders.ts#eventReminderSchema`'s
   * own doc comment. Empty means "use the Calendar's Reminder Default", never
   * "no Reminder at all" — computing that default is #245's own job.
   */
  reminders: z.array(eventReminderSchema),
  /** Set only for a mirrored Calendar's Series (#234); `null` for anything Wicket organises. */
  upstreamId: z.string().nullable(),
  etag: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Series = z.infer<typeof seriesSchema>;

/**
 * One Override (#230, ADR-0025): a single Occurrence that still happens but
 * differs from what its Series would otherwise produce — a moved time, a
 * retitled instance, a relocated one. `originalStart` is how it is matched
 * back to the Series occurrence it replaces (`eventSchema.originalStart`'s
 * own doc comment); a `null` field means "inherit the Series' own value",
 * not "cleared".
 */
export const seriesOverrideSchema = z.object({
  id: z.string(),
  seriesId: z.string(),
  originalStart: z.iso.datetime(),
  start: z.iso.datetime().nullable(),
  end: z.iso.datetime().nullable(),
  title: z.string().nullable(),
  location: z.string().nullable(),
});
export type SeriesOverride = z.infer<typeof seriesOverrideSchema>;

/** `GET /calendars/:calendarId/series/:seriesId`'s response (`routes/calendars.ts`) — the on-demand fetch this ticket's acceptance line names. */
export const seriesBodyResponseSchema = z.object({
  series: seriesSchema,
  overrides: z.array(seriesOverrideSchema),
});
export type SeriesBodyResponse = z.infer<typeof seriesBodyResponseSchema>;

/**
 * One full body save of a Series, as it rides the `seriesSaves` channel
 * (#233) — `noteSaveSchema`'s sibling (`notes.ts`), deliberately the same
 * shape: `id` is the Series' own Client-minted ULID, `saveId` a fresh ULID
 * per save attempt, the idempotency key a retried `POST /sync` replays
 * against. Like a Note body save this **coalesces** (last-write-wins per
 * Series) rather than draining FIFO, so it rides its own array alongside
 * `mutations`/`noteSaves` rather than joining the `UserMutationIntent`
 * union — the structural half (create/permanent-delete, soft-delete/restore,
 * one Occurrence's `exdate`) still rides that queue instead, exactly the
 * split `noteSaveSchema`'s own doc comment draws for a Note's body vs. its
 * structural actions.
 *
 * `overrides` is the Series' **whole** Override set, replaced wholesale on
 * every save — an "this Occurrence only" edit (this ticket's own body) is
 * still a full `seriesSave` whose `overrides` array differs by one entry,
 * never a separate per-Override write path. `calendarId` rides here (not
 * only on `createSeries`) so a save that raced a not-yet-applied
 * `createSeries` intent can still create the row lazily, the same tolerance
 * `note-store.ts#applyOne` gives `noteSaves` racing `createNote`.
 */
export const seriesSaveSchema = z.object({
  id: z.string(),
  saveId: z.string(),
  calendarId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  allDay: z.boolean(),
  floating: z.boolean(),
  tzid: z.string().nullable(),
  dtstart: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  rrules: z.array(z.string()),
  rdates: z.array(z.string()),
  exdates: z.array(z.string()),
  transparency: z.enum(["opaque", "transparent"]),
  attendees: z.array(seriesAttendeeSchema),
  /** `seriesSchema.reminders`' own field, riding the body save the same way `attendees` does. */
  reminders: z.array(eventReminderSchema),
  overrides: z.array(seriesOverrideSchema.omit({ seriesId: true })),
  /**
   * The Client's own answer to the Send / Don't send prompt (#242, ADR-0027)
   * on a self-scheduled Calendar's substantive edit — `true` (the default)
   * for a create, where there is no prompt at all: "Create sends `REQUEST`
   * at once." Ignored on a synced Calendar and on the very first save that
   * actually invites anyone, which always sends regardless.
   */
  sendUpdate: z.boolean().default(true),
});
export type SeriesSave = z.infer<typeof seriesSaveSchema>;

/** One `seriesSaves` outcome — always `applied`, the same "never rejects" shape `noteSaveOutcomeSchema` gives a Note body write. */
export const seriesSaveOutcomeSchema = z.object({
  id: z.string(),
  saveId: z.string(),
  status: z.literal("applied"),
});
export type SeriesSaveOutcome = z.infer<typeof seriesSaveOutcomeSchema>;

/** How long a soft-deleted Series (`trashSeries`) stays restorable before `calendars/series-purge.ts` purges it for good (this ticket's own acceptance line: "`restoreEvent` recreates a deleted Series from a 24-hour snapshot") — `NOTE_TRASH_RETENTION_DAYS`'s own shape, just a far shorter window. */
export const SERIES_TRASH_RETENTION_HOURS = 24;
