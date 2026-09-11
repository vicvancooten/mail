import { z } from "zod";

/**
 * `EventReminder` (#244, ADR-0028): one Reminder held on a Series body
 * (`series.ts#seriesSchema`'s own `reminders` field) — "Event content the
 * User expects to see in every app" (#244's own body), mirrored both ways
 * with Google's `reminders.overrides` (`calendars/google/event-body.ts`) and,
 * for Graph, folded down to its one `reminderMinutesBeforeStart` slot
 * (`calendars/graph/event-body.ts`).
 *
 * `kind: "relative"` is the only shape Wicket ever shows or fires — ADR-0028's
 * Delivery section, #245's own job — and, within that, only `method: "popup"`
 * ones are ever offered as one of the Calendar's `perEventReminders` slots
 * (`visibleReminders` below). `method: "email"` and `kind: "absolute"` (an
 * RFC 5545 `VALARM;TRIGGER;VALUE=DATE-TIME` alarm — no producer on this
 * branch's ancestry yet; Google has none, and CalDAV hasn't landed) round-trip
 * unseen and unfired, exactly as #244's acceptance line asks: content Wicket
 * must carry through a save or a Move without silently dropping it just
 * because it cannot act on it.
 */
export const eventReminderSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("relative"),
    method: z.enum(["popup", "email"]),
    minutesBefore: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("absolute"),
    method: z.enum(["popup", "email"]),
    at: z.iso.datetime(),
  }),
]);
export type EventReminder = z.infer<typeof eventReminderSchema>;

/**
 * One Reminder the User actually sees, edits, and that #245's loop fires —
 * a `relative` `popup` Reminder, the only shape that is. Spelled out rather
 * than `Extract<EventReminder, {kind: "relative"; method: "popup"}>`: the
 * `relative` branch's own `method` field is `"popup" | "email"`, a union
 * that `Extract`'s `extends`-based matching does not narrow — it would
 * resolve to `never`, not the one member this type actually needs.
 */
export type VisibleEventReminder = { kind: "relative"; method: "popup"; minutesBefore: number };

/** Filters a Series' whole `reminders` array down to the ones the Reminder editor renders as a chip (#244's own body: "email and absolute-time alarms ... never shown"). */
export function visibleReminders(reminders: EventReminder[]): VisibleEventReminder[] {
  return reminders.filter(
    (reminder): reminder is VisibleEventReminder =>
      reminder.kind === "relative" && reminder.method === "popup",
  );
}

/** "An Event carries up to five Reminders" (#244's own acceptance line) — the hard ceiling `perEventReminders` (below) is itself capped at. */
export const MAX_EVENT_REMINDERS = 5;

/**
 * What an Origin's backend lets a per-Event Reminder actually hold (#244's
 * own body: "`perEventReminders` — which becomes a count, not a flag"),
 * replacing `calendars.ts#calendarCapabilitiesSchema`'s old boolean. `0` for
 * an Origin that offers no Reminder slot at all (none exist on this branch's
 * ancestry today, but the schema allows it); `1` for Microsoft Graph, whose
 * `reminderMinutesBeforeStart` is a single slot; `5` (`MAX_EVENT_REMINDERS`)
 * for a Local Calendar and for Google, whose `reminders.overrides` has no
 * documented ceiling of its own.
 */
export const perEventRemindersSchema = z.number().int().min(0).max(MAX_EVENT_REMINDERS);

/**
 * A Calendar's Reminder Default (#244, ADR-0028): "Wicket's own setting per
 * Calendar, seeded once and never read from or written to the upstream
 * again" — two independent minute lists, since minutes-before-midnight is
 * meaningless for a timed Event and minutes-before-start is meaningless for
 * an all-day one. `timed` seeds a fresh Event's Reminders when it asks for
 * the Calendar's default; `allDay` is the same for an all-day Event.
 */
export const reminderDefaultSchema = z.object({
  timed: z.array(z.number().int().nonnegative()),
  allDay: z.array(z.number().int().nonnegative()),
});
export type ReminderDefault = z.infer<typeof reminderDefaultSchema>;

/** The Local "Personal" Calendar's own seed (#244's own acceptance line: "10 minutes before" timed). */
export const LOCAL_TIMED_REMINDER_DEFAULT: number[] = [10];
/** "The day before at 09:00 (900 minutes)" (#244's own acceptance line) — 15 hours before the all-day Event's midnight start. */
export const LOCAL_ALL_DAY_REMINDER_DEFAULT: number[] = [900];

/** Four weeks, in minutes — "custom up to four weeks" (#244's own body), the ceiling both preset lists below share. */
export const MAX_REMINDER_MINUTES = 4 * 7 * 24 * 60;

/**
 * The Reminder editor's preset minute values for a **timed** Event (#244's
 * own body: "at start, 5, 10, 15, 30 minutes, 1 hour, 1 day, custom up to
 * four weeks") — a UI convenience list, not the validation source of truth:
 * `eventReminderSchema.minutesBefore` accepts any non-negative integer up to
 * `MAX_REMINDER_MINUTES`, the same way Google/Graph's own minutes fields do.
 */
export const TIMED_REMINDER_PRESET_MINUTES = [0, 5, 10, 15, 30, 60, 1440] as const;

/**
 * The Reminder editor's day-based presets for an **all-day** Event (#244's
 * own body: "all-day Events get day-based presets instead") — each is "N
 * days before, at 09:00", the same anchor `LOCAL_ALL_DAY_REMINDER_DEFAULT`
 * seeds ("the day before at 09:00" is exactly `daysBefore: 1` here, 900
 * minutes). `minutesBefore = (daysBefore - 1) * 1440 + 900`.
 */
export const ALL_DAY_REMINDER_PRESET_DAYS = [1, 2, 7] as const;

/** `ALL_DAY_REMINDER_PRESET_DAYS`' own minutes-before-midnight value, "N days before at 09:00". */
export function allDayPresetMinutes(daysBefore: number): number {
  return (daysBefore - 1) * 1440 + 900;
}
