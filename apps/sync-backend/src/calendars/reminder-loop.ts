import { HOME_TIME_ZONE_UNSET } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { DateTime } from "luxon";
import type { Db } from "../db/client.js";
import { type EventRow, events, users } from "../db/schema.js";
import { insertOutboxEntry } from "../notifier/outbox.js";
import { type PollLoopHandle, startPollLoop } from "../sync/poll-loop.js";
import {
  claimReminderDue,
  dueReminderCandidateIds,
  markReminderMissed,
  occurrenceRealInstant,
  REMINDER_CATCH_UP_GRACE_MS,
} from "./reminder-due-store.js";

/**
 * The reminder loop (#245, ADR-0028): "a 15-second loop atomically claims
 * rows with `dueAt <= now` and `firedAt is null`... the first tick runs at
 * boot" — `startPollLoop`'s (#188) own default already runs an immediate
 * first tick, so this is the shared loop helper's first new caller rather
 * than an eighth hand-rolled copy, ADR-0028's own closing line.
 */
const DEFAULT_INTERVAL_MS = 15_000;

export interface ReminderLoopOptions {
  intervalMs?: number;
  now?: () => Date;
  logger?: FastifyBaseLogger;
}

export type ReminderLoopHandle = PollLoopHandle;

export function startReminderLoop(
  db: Db,
  { intervalMs = DEFAULT_INTERVAL_MS, now = () => new Date(), logger }: ReminderLoopOptions = {},
): ReminderLoopHandle {
  return startPollLoop({
    label: "reminder loop",
    intervalMs,
    logger,
    tick: ({ isStopped }) => runReminderTick(db, { now: now(), logger, isStopped }),
  });
}

export interface ReminderTickDeps {
  now: Date;
  logger?: FastifyBaseLogger;
  isStopped?: () => boolean;
}

/** One tick's worth of work, factored out `outbox-loop.ts#runCalendarOutboxTick`'s own way, so a test can drive it directly: every currently-due row, claimed and resolved one at a time — never a blanket `UPDATE`. */
export async function runReminderTick(db: Db, deps: ReminderTickDeps): Promise<void> {
  const ids = await dueReminderCandidateIds(db, deps.now);
  for (const id of ids) {
    if (deps.isStopped?.()) return;
    try {
      await tickOneReminder(db, id, deps.now);
    } catch (err) {
      deps.logger?.error({ err, reminderDueId: id }, "reminder loop: tick failed");
    }
  }
}

async function tickOneReminder(db: Db, id: string, now: Date): Promise<void> {
  const claimed = await claimReminderDue(db, id, now);
  if (!claimed) return; // Lost the claim — already handled by another tick/process, or no longer due.

  const [eventRow] = await db.select().from(events).where(eq(events.id, claimed.eventId));
  if (eventRow?.status !== "confirmed") {
    // The Occurrence vanished or was cancelled between the candidate query
    // running and this row's own claim landing — a race the claim above
    // only closes against other reminder-loop attempts, not a concurrent
    // Series edit. Silently missed, same as an ordinary catch-up miss.
    await markReminderMissed(db, id, now);
    return;
  }

  const [userRow] = await db
    .select({ homeTimeZone: users.homeTimeZone })
    .from(users)
    .where(eq(users.id, claimed.userId));
  const homeTimeZone = userRow?.homeTimeZone ?? HOME_TIME_ZONE_UNSET;
  const needsZoning = eventRow.allDay || eventRow.floating;
  const realStart = occurrenceRealInstant(eventRow.startAt, needsZoning, homeTimeZone);
  const realEnd = occurrenceRealInstant(eventRow.endAt, needsZoning, homeTimeZone);
  if (realStart === null || realEnd === null) {
    // The Home Time Zone was cleared out from under an all-day/floating
    // Occurrence since this row was last rebuilt — nothing to ring against.
    await markReminderMissed(db, id, now);
    return;
  }

  const outcome = catchUpOutcome(realStart, realEnd, now);
  if (outcome === null) {
    await markReminderMissed(db, id, now);
    return;
  }

  await insertOutboxEntry(db, {
    userId: claimed.userId,
    mailAccountId: null,
    kind: "calendar_reminder",
    dedupKey: reminderDedupKey(claimed),
    payload: {
      kind: "calendar_reminder",
      events: [
        {
          reminderDueId: claimed.id,
          eventId: eventRow.id,
          seriesId: claimed.seriesId,
          title: eventRow.title,
          body: reminderBody(eventRow, homeTimeZone, outcome),
        },
      ],
    },
  });
}

/**
 * ADR-0028's dedup key: `(seriesId, originalStart, minutesBefore, dueAt)` —
 * exactly the tuple that names this Reminder Due row, so the delivery loop,
 * fanout, pruning and badge count need no special-casing for this kind
 * (`db/schema.ts#notifierOutbox`'s own dedup index already enforces
 * `(kind, dedupKey)` uniqueness for every kind alike).
 */
function reminderDedupKey(claimed: {
  seriesId: string;
  originalStart: Date;
  minutesBefore: number;
  dueAt: Date;
}): string {
  return [
    claimed.seriesId,
    claimed.originalStart.toISOString(),
    claimed.minutesBefore,
    claimed.dueAt.toISOString(),
  ].join(":");
}

/** The catch-up rule's own textual outcome (ADR-0028) — `null` means "marked missed silently", every other value is what still fires. */
type CatchUpOutcome = { prefix: string };

/**
 * ADR-0028's catch-up rule, in claim order: an Occurrence that has **ended**
 * never fires, checked first because a short Occurrence can already be over
 * well inside the 15-minute grace window below. Otherwise: not yet started
 * fires "in N min" (`"now"` at zero); started under 15 minutes ago fires
 * once as "started N min ago"; anything past that grace is missed silently.
 */
function catchUpOutcome(realStart: Date, realEnd: Date, now: Date): CatchUpOutcome | null {
  if (now.getTime() >= realEnd.getTime()) return null;

  const diffMs = realStart.getTime() - now.getTime();
  if (diffMs > 0) {
    const minutes = Math.round(diffMs / 60_000);
    return { prefix: minutes === 0 ? "now" : `in ${minutes} min` };
  }
  const sinceStartMs = -diffMs;
  if (sinceStartMs < REMINDER_CATCH_UP_GRACE_MS) {
    const minutes = Math.round(sinceStartMs / 60_000);
    return { prefix: minutes === 0 ? "now" : `started ${minutes} min ago` };
  }
  return null;
}

/** "Body is the time range in the Home Time Zone plus location" (ADR-0028), prefixed with the catch-up outcome's own text. */
function reminderBody(
  eventRow: Pick<EventRow, "startAt" | "endAt" | "allDay" | "floating" | "location">,
  homeTimeZone: string,
  outcome: CatchUpOutcome,
): string {
  const zone = homeTimeZone === HOME_TIME_ZONE_UNSET ? "utc" : homeTimeZone;
  const needsZoning = eventRow.allDay || eventRow.floating;
  const timeRange = eventRow.allDay
    ? "All day"
    : formatTimeRange(eventRow.startAt, eventRow.endAt, needsZoning, zone);
  const parts = [outcome.prefix, timeRange];
  if (eventRow.location) parts.push(eventRow.location);
  return parts.join(" · ");
}

function formatTimeRange(start: Date, end: Date, needsZoning: boolean, zone: string): string {
  // A floating Occurrence's `startAt`/`endAt` are already the "UTC-labeled
  // wall clock" the materialiser stores them as (`materialiser.ts`'s own
  // doc comment) — reading their UTC components directly is exactly reading
  // the wall clock they name, with no zone conversion needed at all. A
  // zoned Occurrence's `startAt`/`endAt` are genuine instants, so those do
  // need the ordinary zone conversion.
  const startLabel = needsZoning
    ? DateTime.fromObject(utcParts(start)).toFormat("h:mm a")
    : DateTime.fromJSDate(start, { zone }).toFormat("h:mm a");
  const endLabel = needsZoning
    ? DateTime.fromObject(utcParts(end)).toFormat("h:mm a")
    : DateTime.fromJSDate(end, { zone }).toFormat("h:mm a");
  return `${startLabel}–${endLabel}`;
}

function utcParts(date: Date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}
