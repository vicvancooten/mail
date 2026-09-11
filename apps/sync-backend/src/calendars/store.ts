import {
  type Calendar,
  DEFAULT_CALENDAR_COLOR,
  LOCAL_ALL_DAY_REMINDER_DEFAULT,
  LOCAL_CALENDAR_CAPABILITIES,
  LOCAL_CALENDAR_ORIGIN,
  LOCAL_TIMED_REMINDER_DEFAULT,
  PERSONAL_CALENDAR_NAME,
  personalCalendarId,
} from "@mail/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { type CalendarRow, calendars, mailAccounts, users } from "../db/schema.js";
import {
  countMirroredEvents,
  type DiscardedMirrorCounts,
  discardMirroredEvents,
} from "./mirror-discard.js";

/**
 * Ensures this User's one undeletable Local "Personal" Calendar exists
 * (#229's acceptance line: "Each User gets exactly one Local 'Personal'
 * Calendar on first use, undeletable"). "First use" is deliberately not a
 * boot-time sweep or a signup hook — it is called from
 * `sync/collection-registry.ts`'s `Calendar` descriptor, the same
 * "find-or-create with a deterministic id" idiom `sync/mutations.ts#applyLabel`
 * uses for a Label — so a User who never opens the Calendar App never gets a
 * row, and one who does gets it the instant they first sync the collection,
 * with no separate provisioning step to keep in sync with signup.
 *
 * `onConflictDoNothing` against `personalCalendarId(userId)` is what makes
 * this idempotent and undeletable in the same stroke: there is no
 * `deleteCalendar` intent that can ever target this id (#229's demoable
 * slice ships no calendar-editing intents at all), and a concurrent sync
 * round from two devices both calling this at once converges on one row
 * rather than racing to create two.
 *
 * The Home Time Zone (#189) is read once, at creation, and never re-read
 * afterward — a User who sets it later does not retroactively move this
 * Calendar's `timeZone`. Acceptable for this ticket's "no grid yet, no
 * Occurrences yet" slice; revisit if #233 (creating/editing an Event) finds
 * that surprising in practice.
 *
 * `mailAccountId` is seeded from the User's oldest Mail Account at creation
 * (ADR-0027: "the Personal Calendar takes the User's first Mail Account"),
 * `null` for a User who has none yet — the "and follows when one is added
 * later" half of that same line has no hook of its own yet (#241's own
 * closing comment: a User who syncs Calendars before ever adding a Mail
 * Account keeps a Personal Calendar with no Mail Account until something
 * else sets one, `calendars/mutations.ts#setCalendarMailAccount` included).
 */
export async function ensurePersonalCalendar(db: Db | Tx, userId: string): Promise<void> {
  const id = personalCalendarId(userId);
  const existing = await db.query.calendars.findFirst({ where: eq(calendars.id, id) });
  if (existing) return;

  const [user] = await db
    .select({ homeTimeZone: users.homeTimeZone })
    .from(users)
    .where(eq(users.id, userId));
  const [oldestMailAccount] = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(eq(mailAccounts.userId, userId))
    .orderBy(asc(mailAccounts.createdAt))
    .limit(1);

  await db
    .insert(calendars)
    .values({
      id,
      userId,
      name: PERSONAL_CALENDAR_NAME,
      description: null,
      timeZone: user?.homeTimeZone ?? "",
      originType: "local",
      connectedAccountId: null,
      color: DEFAULT_CALENDAR_COLOR,
      // The very first Calendar a User ever gets is their default for new
      // Events (CONTEXT.md) — nothing else exists yet to contend with it.
      isDefault: true,
      mailAccountId: oldestMailAccount?.id ?? null,
      mirrored: true,
      capabilities: LOCAL_CALENDAR_CAPABILITIES,
      remindersEnabled: true,
      // #244's own acceptance line: "10 minutes before" timed, "the day
      // before at 09:00 (900 minutes)" all-day — seeded once, right here,
      // never touched again.
      reminderDefault: {
        timed: LOCAL_TIMED_REMINDER_DEFAULT,
        allDay: LOCAL_ALL_DAY_REMINDER_DEFAULT,
      },
    })
    .onConflictDoNothing({ target: calendars.id });
}

/** No Calendar row exists for this User with this id — a bad id, or someone else's Calendar. */
export class CalendarNotFoundError extends Error {
  constructor(id: string) {
    super(`Calendar ${id} not found`);
    this.name = "CalendarNotFoundError";
  }
}

/**
 * The `mirrored` checklist only ever applies to a Connected Account's own
 * Calendars (#235's own acceptance line, `calendarSchema`'s own doc
 * comment: "Always `true` for a Local Calendar: there is no checklist to
 * turn it off from") — thrown for a Local Calendar id passed to
 * `unmirrorCalendar`/`mirrorCalendar`.
 */
export class CalendarNotMirrorableError extends Error {
  constructor(id: string) {
    super(`Calendar ${id} is not a Connected Account's Calendar`);
    this.name = "CalendarNotMirrorableError";
  }
}

async function getOwnConnectedAccountCalendar(
  db: Db | Tx,
  userId: string,
  id: string,
): Promise<CalendarRow> {
  const [row] = await db
    .select()
    .from(calendars)
    .where(and(eq(calendars.id, id), eq(calendars.userId, userId)))
    .limit(1);
  if (!row) throw new CalendarNotFoundError(id);
  if (row.originType !== "connectedAccount") throw new CalendarNotMirrorableError(id);
  return row;
}

/** The confirm dialog's preview, before anything is actually discarded — see `mirror-discard.ts#countMirroredEvents`'s own doc comment. */
export async function unmirrorImpact(
  db: Db,
  userId: string,
  id: string,
): Promise<DiscardedMirrorCounts> {
  await getOwnConnectedAccountCalendar(db, userId, id);
  return countMirroredEvents(db, id);
}

export interface UnmirrorCalendarResult {
  calendar: CalendarRow;
  discarded: DiscardedMirrorCounts;
}

/**
 * Unmirroring (#235's own acceptance line): "confirmed, immediate, no
 * Undo; the row kept so it can be re-mirrored later." Deliberately **not**
 * an Optimistic Action — there is no queued intent, no inverse to replay;
 * this runs synchronously in the request that calls it, inside one
 * transaction with the discard it triggers, so a crash mid-way never
 * leaves `mirrored: false` with the Occurrences still sitting there (or
 * vice versa).
 *
 * Idempotent: calling this on an already-unmirrored Calendar discards
 * nothing a second time (there is nothing left to discard) and still
 * succeeds — a User double-clicking the checklist entry mid-request never
 * sees an error for it.
 *
 * `googleSyncToken`/`graphDeltaLink`/`missingConfirmations` are reset
 * alongside `mirrored` so a later re-mirror starts either provider's own
 * "no stored cursor" initial list fresh (`google/event-sync.ts`,
 * `graph/event-sync.ts`), rather than resuming a cursor for data that no
 * longer exists locally.
 */
export async function unmirrorCalendar(
  db: Db,
  userId: string,
  id: string,
): Promise<UnmirrorCalendarResult> {
  return db.transaction(async (tx) => {
    const row = await getOwnConnectedAccountCalendar(tx, userId, id);
    const discarded = row.mirrored ? await discardMirroredEvents(tx, id) : { events: 0 };

    await tx
      .update(calendars)
      .set({
        mirrored: false,
        googleSyncToken: null,
        graphDeltaLink: null,
        missingConfirmations: 0,
        isDefault: false,
        updatedAt: new Date(),
      })
      .where(eq(calendars.id, id));

    if (row.isDefault) {
      // #235's own acceptance line: "A default Calendar sitting in an
      // unmirrored Calendar falls back to the Local Personal Calendar
      // silently" — `ensurePersonalCalendar` covers a User who has never
      // opened the Calendar App (so has no Local Calendar yet either).
      await ensurePersonalCalendar(tx, userId);
      await tx
        .update(calendars)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(calendars.id, personalCalendarId(userId)));
    }

    const [updated] = await tx.select().from(calendars).where(eq(calendars.id, id)).limit(1);
    if (!updated) throw new Error(`Calendar ${id} disappeared mid-transaction`);
    return { calendar: updated, discarded };
  });
}

/**
 * Re-mirroring: flips `mirrored` back on so the next poll tick's Event
 * cadence (`poll-loop.ts`'s own `mirrored: true` filter) picks this
 * Calendar back up. Idempotent the same way `unmirrorCalendar` is.
 */
export async function mirrorCalendar(db: Db, userId: string, id: string): Promise<CalendarRow> {
  const row = await getOwnConnectedAccountCalendar(db, userId, id);
  if (row.mirrored) return row;

  await db
    .update(calendars)
    .set({ mirrored: true, updatedAt: new Date() })
    .where(eq(calendars.id, id));
  const [updated] = await db.select().from(calendars).where(eq(calendars.id, id)).limit(1);
  if (!updated) throw new Error(`Calendar ${id} disappeared mid-update`);
  return updated;
}

/** Maps a stored Calendar row to ADR-0011's wire projection. */
export function toWireCalendar(row: CalendarRow): Calendar {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    description: row.description,
    timeZone: row.timeZone,
    origin:
      row.originType === "local"
        ? LOCAL_CALENDAR_ORIGIN
        : { type: "connectedAccount", connectedAccountId: row.connectedAccountId ?? "" },
    color: row.color,
    isDefault: row.isDefault,
    mailAccountId: row.mailAccountId,
    mirrored: row.mirrored,
    capabilities: row.capabilities,
    remindersEnabled: row.remindersEnabled,
    reminderDefault: row.reminderDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
