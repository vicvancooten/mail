import { HOME_TIME_ZONE_UNSET, type SnoozeUntil, visibleReminders } from "@mail/shared";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "../db/client.js";
import {
  type CalendarRow,
  calendars,
  events,
  mailAccounts,
  type ReminderDueRow,
  reminderDue,
  type SeriesRow,
  series,
  users,
} from "../db/schema.js";

/**
 * The Reminder Due table's one writer (#245, ADR-0028): derives the set of
 * `(Occurrence, minutesBefore)` rows a Series' Reminders imply, over the
 * next five weeks, and makes the table agree with it — the exact "make the
 * stored rows agree with a fresh expansion" shape
 * `series-store.ts#rematerialiseSeries` already gives the `events` table
 * itself, one level up.
 *
 * Scope note: only genuine `series` rows are ever rebuilt here, the same
 * boundary `materialise-loop.ts#selectMaterialisableSeries` already draws —
 * a mirrored Calendar's raw ingested Occurrences
 * (`calendars/google/event-sync.ts`) have no backing Series row at all
 * (`events.seriesId`'s own doc comment), so they carry no Reminder Due rows
 * either, until that reconciliation work lands. Not a gap this ticket opens.
 */

/** "Kept only for Occurrences starting within the next five weeks" (ADR-0028) — "the longest Reminder is four [weeks]", so five weeks is that plus a buffer. */
export const REMINDER_DUE_WINDOW_MS = 5 * 7 * 24 * 60 * 60 * 1000;

/** The catch-up rule's own grace period (ADR-0028): "fires once as 'started N min ago' if it began under 15 minutes ago". */
export const REMINDER_CATCH_UP_GRACE_MS = 15 * 60 * 1000;

/**
 * Reads a "UTC-labeled wall clock" instant's own date/time components back
 * as wall-clock components in `zone` — `calendars/materialiser.ts
 * #fromRRuleSpace`'s exact operation. Duplicated at this small a size
 * rather than exported across an unrelated module boundary (that function's
 * own vocabulary is "rrule space", not "Home Time Zone").
 */
function wallClockInstant(wallClock: Date, zone: string): Date {
  return DateTime.fromObject(
    {
      year: wallClock.getUTCFullYear(),
      month: wallClock.getUTCMonth() + 1,
      day: wallClock.getUTCDate(),
      hour: wallClock.getUTCHours(),
      minute: wallClock.getUTCMinutes(),
      second: wallClock.getUTCSeconds(),
      millisecond: wallClock.getUTCMilliseconds(),
    },
    { zone },
  ).toJSDate();
}

/**
 * The real instant an Occurrence's `field` names, resolved in the User's
 * Home Time Zone for an all-day or floating Occurrence — "the Sync Backend
 * has no viewer zone" (ADR-0028), so `events.startAt`/`endAt` for those two
 * cases are stored the same "UTC-labeled wall clock" way the materialiser
 * itself works in, not a real instant. `null` only when that resolution is
 * needed and the Home Time Zone has not been seeded yet
 * (`HOME_TIME_ZONE_UNSET`) — nothing can be computed against it yet.
 */
export function occurrenceRealInstant(
  wallClockOrInstant: Date,
  needsZoning: boolean,
  homeTimeZone: string,
): Date | null {
  if (!needsZoning) return wallClockOrInstant;
  if (homeTimeZone === HOME_TIME_ZONE_UNSET) return null;
  return wallClockInstant(wallClockOrInstant, homeTimeZone);
}

/**
 * The effective Reminder minutes for one Occurrence (ADR-0028, `reminders.ts`'s
 * own doc comment): the Series' own visible (`relative`+`popup`) Reminders
 * where it set *any* Reminder at all, else the Calendar's Reminder Default
 * for the matching timed/all-day list — "an empty array means use the
 * Calendar's Reminder Default, never no Reminder at all".
 */
export function effectiveReminderMinutes(
  seriesReminders: SeriesRow["reminders"],
  reminderDefault: CalendarRow["reminderDefault"],
  allDay: boolean,
): number[] {
  if (seriesReminders && seriesReminders.length > 0) {
    return visibleReminders(seriesReminders).map((reminder) => reminder.minutesBefore);
  }
  return allDay ? reminderDefault.allDay : reminderDefault.timed;
}

/**
 * Whether this Series' owning User has declined it (ADR-0028's "Skipped":
 * "an Occurrence the User declined") — "self" is derived from the Calendar's
 * own Connected Account, `series-store.ts#answerInvitation`'s exact
 * reasoning, never taken from an ambient caller identity. A Local Calendar's
 * Series is never declined this way — there is no mirrored mailbox address
 * to match an attendee entry against.
 */
async function isDeclinedForUser(
  db: Db,
  seriesRow: Pick<SeriesRow, "attendees">,
  calendarRow: Pick<CalendarRow, "originType" | "connectedAccountId">,
): Promise<boolean> {
  if (calendarRow.originType !== "connectedAccount" || seriesRow.attendees.length === 0) {
    return false;
  }
  const [mailAccountRow] = await db
    .select({ emailAddress: mailAccounts.emailAddress })
    .from(mailAccounts)
    .where(eq(mailAccounts.connectedAccountId, calendarRow.connectedAccountId ?? ""));
  if (!mailAccountRow) return false;

  const normalized = mailAccountRow.emailAddress.trim().toLowerCase();
  return seriesRow.attendees.some(
    (attendee) =>
      attendee.email.trim().toLowerCase() === normalized && attendee.responseStatus === "declined",
  );
}

/**
 * Rebuilds every Reminder Due row for one Series (#245, ADR-0028) — the
 * table's one write path. Called by `series-store.ts#rematerialiseSeries`
 * right after it makes the `events` table agree with the Series' own
 * expansion (a Series/Override edit, or the daily Materialisation Window
 * roll — ADR-0028's "rolled forward daily" line), and by the calendar/User
 * sweeps below whenever the Reminder toggle, Reminder Default, or Home Time
 * Zone changes instead.
 *
 * Declined, a disabled Calendar toggle, or a soft-deleted Series all mean
 * "no Reminders at all" — every existing row for the Series is dropped and
 * nothing rebuilt. Otherwise: every still-materialised, not-yet-ended
 * Occurrence within the next five weeks gets one row per effective
 * Reminder minute, upserted by `(eventId, minutesBefore)`; anything no
 * longer wanted (the window rolled past it, `minutesBefore` was removed
 * from the list, the Occurrence itself is gone) is deleted outright.
 *
 * The upsert's own `CASE` is what makes "moving an Event after its Reminder
 * fired recomputes `dueAt`, clears `firedAt`, and it fires again" true while
 * *also* making the far more common case — a rebuild that recomputes the
 * exact same `dueAt` because nothing about this Occurrence's own timing
 * changed — leave a fired/missed row's own outcome alone. Without it, the
 * daily roll would silently re-arm every Reminder that had already rung.
 */
export async function rebuildReminderDueForSeries(
  db: Db,
  seriesRow: SeriesRow,
  calendarRow: CalendarRow,
  homeTimeZone: string,
  now: Date = new Date(),
): Promise<void> {
  const declined = await isDeclinedForUser(db, seriesRow, calendarRow);
  if (!calendarRow.remindersEnabled || seriesRow.deletedAt !== null || declined) {
    await db.delete(reminderDue).where(eq(reminderDue.seriesId, seriesRow.id));
    return;
  }

  const windowEnd = new Date(now.getTime() + REMINDER_DUE_WINDOW_MS);
  const occurrenceRows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.seriesId, seriesRow.id),
        eq(events.status, "confirmed"),
        gt(events.endAt, now),
        lte(events.startAt, windowEnd),
      ),
    );

  const desired: (typeof reminderDue.$inferInsert)[] = [];
  for (const occurrence of occurrenceRows) {
    const needsZoning = occurrence.allDay || occurrence.floating;
    const realStart = occurrenceRealInstant(occurrence.startAt, needsZoning, homeTimeZone);
    if (realStart === null) continue; // Home Time Zone not seeded yet.

    const minutesList = effectiveReminderMinutes(
      seriesRow.reminders,
      calendarRow.reminderDefault,
      occurrence.allDay,
    );
    for (const minutesBefore of minutesList) {
      desired.push({
        id: `${occurrence.id}:${minutesBefore}`,
        userId: seriesRow.userId,
        calendarId: seriesRow.calendarId,
        seriesId: seriesRow.id,
        eventId: occurrence.id,
        originalStart: occurrence.originalStart,
        minutesBefore,
        dueAt: new Date(realStart.getTime() - minutesBefore * 60_000),
        updatedAt: now,
      });
    }
  }

  // Snoozed rows are excluded from the "existing" set entirely — ADR-0028:
  // "flagged so a rebuild neither recomputes nor drops it" — rather than
  // filtered out of `staleIds` below, since a snoozed row's own id
  // (`snoozeReminderDue`'s own scheme, not `${eventId}:${minutesBefore}`)
  // never collides with a `desired` id anyway; excluding it here is just
  // one less row for the stale-deletion query to have to reason about.
  const existingRows = await db
    .select({ id: reminderDue.id })
    .from(reminderDue)
    .where(and(eq(reminderDue.seriesId, seriesRow.id), eq(reminderDue.snoozed, false)));
  const desiredIds = new Set(desired.map((row) => row.id));
  const staleIds = existingRows.map((row) => row.id).filter((id) => !desiredIds.has(id));
  if (staleIds.length > 0) {
    await db.delete(reminderDue).where(inArray(reminderDue.id, staleIds));
  }
  if (desired.length === 0) return;

  await db
    .insert(reminderDue)
    .values(desired)
    .onConflictDoUpdate({
      target: reminderDue.id,
      set: {
        dueAt: sql`excluded.due_at`,
        status: sql`case when ${reminderDue.dueAt} = excluded.due_at then ${reminderDue.status} else 'pending' end`,
        firedAt: sql`case when ${reminderDue.dueAt} = excluded.due_at then ${reminderDue.firedAt} else null end`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/** This Calendar's owning User's Home Time Zone, or `HOME_TIME_ZONE_UNSET` for one gone missing (never expected in practice). */
async function homeTimeZoneForUser(db: Db, userId: string): Promise<string> {
  const [userRow] = await db
    .select({ homeTimeZone: users.homeTimeZone })
    .from(users)
    .where(eq(users.id, userId));
  return userRow?.homeTimeZone ?? HOME_TIME_ZONE_UNSET;
}

/**
 * Rebuilds every Series' Reminder Due rows on one Calendar (ADR-0028: "the
 * Calendar's toggle" and "Reminder Default" changing) — `sync/mutations.ts`'s
 * `setCalendarRemindersEnabled`/`setCalendarReminderDefault` handlers call
 * this right after applying the change.
 */
export async function rebuildReminderDueForCalendar(
  db: Db,
  calendarId: string,
  now: Date = new Date(),
): Promise<void> {
  const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
  if (!calendarRow) return;
  const homeTimeZone = await homeTimeZoneForUser(db, calendarRow.userId);

  const seriesRows = await db
    .select()
    .from(series)
    .where(and(eq(series.calendarId, calendarId), isNull(series.deletedAt)));
  for (const seriesRow of seriesRows) {
    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, homeTimeZone, now);
  }
}

/**
 * Rebuilds every Reminder Due row across every Calendar this User owns
 * (ADR-0028: "the User's Home Time Zone" changing recomputes every all-day
 * and floating `dueAt`) — `sync/mutations.ts`'s `setHomeTimeZone` handler
 * calls this right after applying the change.
 */
export async function rebuildReminderDueForUser(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const homeTimeZone = await homeTimeZoneForUser(db, userId);
  const rows = await db
    .select({ series, calendar: calendars })
    .from(series)
    .innerJoin(calendars, eq(calendars.id, series.calendarId))
    .where(and(eq(series.userId, userId), isNull(series.deletedAt)));
  for (const row of rows) {
    await rebuildReminderDueForSeries(db, row.series, row.calendar, homeTimeZone, now);
  }
}

/** Every `pending` row currently due, oldest first — `reminder-loop.ts`'s own candidate query, `compose/pending-send.ts#dueSendCandidateIds`'s exact shape. */
export async function dueReminderCandidateIds(db: Db, now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({ id: reminderDue.id })
    .from(reminderDue)
    .where(and(eq(reminderDue.status, "pending"), lte(reminderDue.dueAt, now)))
    .orderBy(reminderDue.dueAt);
  return rows.map((row) => row.id);
}

/**
 * The atomic claim (ADR-0028: "atomically claims rows... using the
 * `compose/pending-send.ts` claim pattern"). Provisionally marks the row
 * `fired` in the same conditional `UPDATE` that takes it — `finalizeReminderMissed`
 * below corrects that to `missed` when the catch-up rule says so, which is
 * safe precisely because only the winner of this claim ever reaches that
 * step. `null` means the claim was lost: already claimed by another tick or
 * process, or no longer due.
 */
export async function claimReminderDue(
  db: Db,
  id: string,
  now: Date = new Date(),
): Promise<ReminderDueRow | null> {
  const [row] = await db
    .update(reminderDue)
    .set({ status: "fired", firedAt: now, updatedAt: now })
    .where(
      and(eq(reminderDue.id, id), eq(reminderDue.status, "pending"), lte(reminderDue.dueAt, now)),
    )
    .returning();
  return row ?? null;
}

/** Downgrades a just-claimed row to `missed` — the catch-up rule's silent branch. Only ever called by the process that just won `claimReminderDue`, so no predicate is needed to keep it exclusive. */
export async function markReminderMissed(
  db: Db,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(reminderDue)
    .set({ status: "missed", updatedAt: now })
    .where(eq(reminderDue.id, id));
}

/**
 * The Snooze action's one write path (#246, ADR-0028): "a snoozed Reminder
 * is a one-off row in that same table (`dueAt = now + N`), flagged so a
 * rebuild neither recomputes nor drops it, deleted if the Occurrence is
 * cancelled and left alone if it moves." Called once per fired row a Snooze
 * request names — the OS notification's button, the toast, and the Event
 * page all resolve to the same fired `reminder_due` id(s), plural only
 * because a grouped notification shares one Snooze action across several.
 *
 * Deliberately re-derives the Occurrence from `events` rather than trusting
 * anything about it the fired row itself still carries: `eventStart` needs
 * the Occurrence's *current* start (a move after it fired is exactly the
 * case ADR-0028 calls out), and a since-cancelled Occurrence must reject
 * the same way `tickOneReminder` treats one it finds gone.
 */
export async function snoozeReminderDue(
  db: Db,
  userId: string,
  firedReminderDueId: string,
  snoozeUntil: SnoozeUntil,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [firedRow] = await db
    .select()
    .from(reminderDue)
    .where(and(eq(reminderDue.id, firedReminderDueId), eq(reminderDue.userId, userId)));
  if (!firedRow) return { ok: false, reason: "reminder_not_found" };
  // Not a hard "must be `fired`" requirement — a retried/duplicate Snooze
  // request for a row this same action already snoozed (or one raced by
  // another device) is a harmless no-op, the ordinary idempotency-ledger
  // posture every other Optimistic Action intent already takes.
  if (firedRow.status === "missed") return { ok: false, reason: "reminder_missed" };

  const [eventRow] = await db.select().from(events).where(eq(events.id, firedRow.eventId));
  if (eventRow?.status !== "confirmed") {
    return { ok: false, reason: "event_not_found" };
  }

  const homeTimeZone = await homeTimeZoneForUser(db, userId);
  const needsZoning = eventRow.allDay || eventRow.floating;
  const realEnd = occurrenceRealInstant(eventRow.endAt, needsZoning, homeTimeZone);
  if (realEnd !== null && realEnd.getTime() <= now.getTime()) {
    return { ok: false, reason: "event_ended" };
  }

  let dueAt: Date;
  if (snoozeUntil.kind === "minutes") {
    dueAt = new Date(now.getTime() + snoozeUntil.minutes * 60_000);
  } else {
    const realStart = occurrenceRealInstant(eventRow.startAt, needsZoning, homeTimeZone);
    if (realStart === null) return { ok: false, reason: "home_time_zone_unset" };
    if (realStart.getTime() <= now.getTime()) return { ok: false, reason: "event_already_started" };
    dueAt = realStart;
  }

  await db.insert(reminderDue).values({
    id: `${firedRow.id}:snooze:${now.getTime()}`,
    userId,
    calendarId: firedRow.calendarId,
    seriesId: firedRow.seriesId,
    eventId: firedRow.eventId,
    originalStart: firedRow.originalStart,
    minutesBefore: firedRow.minutesBefore,
    dueAt,
    status: "pending",
    firedAt: null,
    snoozed: true,
    createdAt: now,
    updatedAt: now,
  });

  return { ok: true };
}
