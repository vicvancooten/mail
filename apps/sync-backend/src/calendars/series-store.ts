import { hostname } from "node:os";
import {
  HOME_TIME_ZONE_UNSET,
  type Series,
  type SeriesOverride,
  type SeriesSave,
} from "@mail/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  type CalendarRow,
  calendarOutbox,
  calendars,
  type EventRow,
  events,
  mailAccounts,
  type OverrideRow,
  overrides,
  type SeriesRow,
  series,
  users,
} from "../db/schema.js";
import { normalizeAddress } from "../invitations/local-fallback.js";
import { type OrganizerIdentity, queueOrganizerSend } from "../invitations/local-organizer.js";
import type { OrganizerIcsAttendee } from "../invitations/organizer-ics.js";
import { recordTombstones } from "../sync/tombstones.js";
import { computeMaterialisationWindow } from "./materialise-loop.js";
import { materialiseSeries } from "./materialiser.js";
import { type CalendarOutboxOperation, enqueueOutboxWrite } from "./outbox-store.js";
import { rebuildReminderDueForSeries } from "./reminder-due-store.js";

/**
 * Whether a Calendar's Series edits should ride the write-back outbox
 * (#237, ADR-0025): only a mirrored, writable Connected-Account Calendar has
 * anything upstream to push to — a Local Calendar's Series (`originType:
 * "local"`) is Wicket's own, and an unmirrored or read-only mirrored one
 * (`mirrored: false`, or `capabilities.writable: false`) has nothing this
 * outbox is allowed to touch.
 */
function shouldPushUpstream(calendarRow: CalendarRow): boolean {
  return (
    calendarRow.originType === "connectedAccount" &&
    calendarRow.mirrored &&
    calendarRow.capabilities.writable
  );
}

/**
 * Every structural mutation below's own outbox call — enqueues only when
 * `shouldPushUpstream` says there's somewhere to push to; a Local Calendar's
 * edit is a no-op here, same as before this ticket. `sendInvitations`
 * defaults on (ADR-0025's own acceptance line, `canSuppressInviteMail`) —
 * there is no Client control for the toggle yet, so every push behaves as
 * if the User left it at its default.
 */
async function enqueueOutboxIfMirrored(
  db: Db,
  userId: string,
  seriesRow: Pick<SeriesRow, "id" | "calendarId">,
  operation: CalendarOutboxOperation,
  sendInvitations = true,
  responseStatus?: SeriesRow["attendees"][number]["responseStatus"] | null,
): Promise<void> {
  const [calendarRow] = await db
    .select()
    .from(calendars)
    .where(eq(calendars.id, seriesRow.calendarId));
  if (!calendarRow || !shouldPushUpstream(calendarRow)) return;
  await enqueueOutboxWrite(db, {
    userId,
    calendarId: seriesRow.calendarId,
    seriesId: seriesRow.id,
    operation,
    sendInvitations,
    responseStatus,
  });
}

/**
 * The Calendar's own Organiser identity (#242, ADR-0027) — `null` for a
 * synced Calendar (`invitesSentByUpstream: true`, the upstream sends
 * instead) or one with no Mail Account yet (the attendee field is disabled
 * client-side for that case, this is defense in depth). Never an Alias:
 * `ORGANIZER` and the SMTP `From` are always the Mail Account's own address.
 */
async function resolveOrganizerIdentity(
  db: Db,
  calendarRow: CalendarRow,
): Promise<OrganizerIdentity | null> {
  if (calendarRow.capabilities.invitesSentByUpstream) return null;
  if (!calendarRow.mailAccountId) return null;
  const [mailAccount] = await db
    .select({ id: mailAccounts.id, emailAddress: mailAccounts.emailAddress })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, calendarRow.mailAccountId));
  if (!mailAccount) return null;
  return { mailAccountId: mailAccount.id, address: mailAccount.emailAddress, name: null };
}

/** Whether a `seriesSave` touched a field ADR-0027 calls out for the Send / Don't send prompt (time, recurrence, location, title, description) — Attendees are diffed separately by the caller. */
function seriesBodyChanged(previous: SeriesRow, next: SeriesRow): boolean {
  return (
    previous.title !== next.title ||
    previous.description !== next.description ||
    previous.location !== next.location ||
    previous.dtstart.getTime() !== next.dtstart.getTime() ||
    previous.durationMs !== next.durationMs ||
    previous.allDay !== next.allDay ||
    previous.floating !== next.floating ||
    previous.tzid !== next.tzid ||
    JSON.stringify(previous.rrules) !== JSON.stringify(next.rrules) ||
    JSON.stringify(previous.rdates) !== JSON.stringify(next.rdates) ||
    JSON.stringify(previous.exdates) !== JSON.stringify(next.exdates)
  );
}

function toIcsAttendees(attendees: SeriesRow["attendees"]): OrganizerIcsAttendee[] {
  return attendees.map((attendee) => ({ address: attendee.email, name: attendee.name }));
}

/**
 * Queues whatever organiser-side iMIP mail a `seriesSave` owes its Attendees
 * on a self-scheduled Calendar (#242, ADR-0027) — the mirror image of #241's
 * own Answer. A no-op for a synced Calendar or one with no Mail Account
 * (`resolveOrganizerIdentity`).
 *
 * The very first send (`organizerFirstSentAt` still `null`) always goes out
 * — "Create sends `REQUEST` at once", no prompt — and never bumps `SEQUENCE`
 * (ADR-0027: "bumps... after the first"). Every later send is gated on
 * `sendUpdate`, the Client's own answer to the Send / Don't send prompt: when
 * only the Attendee list changed, the mail is scoped to the delta alone (an
 * added Attendee gets `REQUEST` alone, a removed one `CANCEL` alone);
 * touching anything else re-sends `REQUEST` to the Series' whole current
 * Attendee list, on top of that same delta.
 */
async function sendOrganizerUpdates(
  db: Db,
  userId: string,
  calendarRow: CalendarRow,
  previousRow: SeriesRow | null,
  row: SeriesRow,
  sendUpdate: boolean,
): Promise<void> {
  const organizer = await resolveOrganizerIdentity(db, calendarRow);
  if (!organizer) return;

  const previousAttendees = previousRow?.attendees ?? [];
  const added = row.attendees.filter(
    (attendee) =>
      !previousAttendees.some(
        (existing) => normalizeAddress(existing.email) === normalizeAddress(attendee.email),
      ),
  );
  const removed = previousAttendees.filter(
    (attendee) =>
      !row.attendees.some(
        (existing) => normalizeAddress(existing.email) === normalizeAddress(attendee.email),
      ),
  );

  if (row.organizerFirstSentAt === null) {
    if (row.attendees.length === 0) return;
    await queueOrganizerSend(db, userId, row, organizer, {
      method: "REQUEST",
      recipients: toIcsAttendees(row.attendees),
      bumpSequence: false,
    });
    await db.update(series).set({ organizerFirstSentAt: new Date() }).where(eq(series.id, row.id));
    return;
  }

  if (!sendUpdate) return;

  const substantiveChanged = previousRow !== null && seriesBodyChanged(previousRow, row);
  if (added.length === 0 && removed.length === 0 && !substantiveChanged) return;

  let current = row;
  let bumped = false;
  const requestRecipients = substantiveChanged ? current.attendees : added;
  if (requestRecipients.length > 0) {
    const result = await queueOrganizerSend(db, userId, current, organizer, {
      method: "REQUEST",
      recipients: toIcsAttendees(requestRecipients),
      bumpSequence: true,
    });
    current = { ...current, sequence: result.sequence };
    bumped = true;
  }
  if (removed.length > 0) {
    await queueOrganizerSend(db, userId, current, organizer, {
      method: "CANCEL",
      recipients: toIcsAttendees(removed),
      bumpSequence: !bumped,
    });
  }
}

/** `trashSeries`'s own organiser-side send: `CANCEL` to every current Attendee, unconditional (no Send / Don't send prompt for a delete). A Series never actually invited (`organizerFirstSentAt` still `null`) has nobody to tell. */
async function sendOrganizerCancelForWholeSeries(
  db: Db,
  userId: string,
  calendarRow: CalendarRow,
  row: SeriesRow,
): Promise<void> {
  if (row.organizerFirstSentAt === null || row.attendees.length === 0) return;
  const organizer = await resolveOrganizerIdentity(db, calendarRow);
  if (!organizer) return;
  await queueOrganizerSend(db, userId, row, organizer, {
    method: "CANCEL",
    recipients: toIcsAttendees(row.attendees),
    bumpSequence: true,
  });
}

/** `addExdate`'s own organiser-side send: `CANCEL` with `RECURRENCE-ID` to every current Attendee (ADR-0027: "Deleting... one Occurrence sends `CANCEL` with `RECURRENCE-ID`"). */
async function sendOrganizerOccurrenceCancel(
  db: Db,
  userId: string,
  calendarRow: CalendarRow,
  row: SeriesRow,
  recurrenceId: string,
): Promise<void> {
  if (row.organizerFirstSentAt === null || row.attendees.length === 0) return;
  const organizer = await resolveOrganizerIdentity(db, calendarRow);
  if (!organizer) return;
  await queueOrganizerSend(db, userId, row, organizer, {
    method: "CANCEL",
    recipients: toIcsAttendees(row.attendees),
    recurrenceId,
    bumpSequence: true,
  });
}

/** Maps a stored Series row to its on-demand wire projection (`routes/calendars.ts`). */
export function toWireSeries(row: SeriesRow): Series {
  return {
    id: row.id,
    userId: row.userId,
    calendarId: row.calendarId,
    uid: row.uid,
    sequence: row.sequence,
    title: row.title,
    description: row.description,
    location: row.location,
    allDay: row.allDay,
    floating: row.floating,
    tzid: row.tzid,
    dtstart: row.dtstart.toISOString(),
    durationMs: row.durationMs,
    rrules: row.rrules,
    rdates: row.rdates,
    exdates: row.exdates,
    transparency: row.transparency,
    attendees: row.attendees,
    reminders: row.reminders,
    upstreamId: row.upstreamId,
    etag: row.etag,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Maps a stored Override row to its on-demand wire projection, alongside its owning Series (`routes/calendars.ts`). */
export function toWireOverride(row: OverrideRow): SeriesOverride {
  return {
    id: row.id,
    seriesId: row.seriesId,
    originalStart: row.originalStart.toISOString(),
    start: row.start?.toISOString() ?? null,
    end: row.end?.toISOString() ?? null,
    title: row.title,
    location: row.location,
  };
}

/**
 * The materialiser's one write path (#230): expands `seriesRow` plus its
 * Overrides across `[windowStart, windowEnd]` and makes the `events` table
 * agree with the result — upserting every Occurrence the expansion still
 * produces, and destroying every Occurrence row of this Series the
 * expansion no longer produces (the window rolled past it, an `exdate` now
 * covers it, or the Series itself shrank). `calendars/materialise-loop.ts`
 * calls this once per Series on every daily sweep; nothing else writes to
 * `events`.
 *
 * A destroyed Occurrence is recorded the same way `note-purge.ts` records
 * one: delete the row, then `recordTombstones` for its id — `events` has no
 * `deletedAt` to soft-delete through instead, and a plain `DELETE` updates
 * no row for `bump_sync_rev` to fire on, so the tombstone is the only way a
 * Client's next `POST /sync` learns the row is gone.
 */
export async function rematerialiseSeries(
  db: Db,
  seriesRow: SeriesRow,
  windowStart: Date,
  windowEnd: Date,
): Promise<void> {
  const overrideRows = await db
    .select()
    .from(overrides)
    .where(eq(overrides.seriesId, seriesRow.id));
  const overridesByOriginalStart = new Map(
    overrideRows.map((row) => [
      row.originalStart.toISOString(),
      {
        originalStart: row.originalStart,
        start: row.start,
        end: row.end,
        title: row.title,
        location: row.location,
      },
    ]),
  );

  const occurrences = materialiseSeries(
    {
      dtstart: seriesRow.dtstart,
      durationMs: seriesRow.durationMs,
      rrules: seriesRow.rrules,
      rdates: seriesRow.rdates,
      exdates: seriesRow.exdates,
      tzid: seriesRow.tzid,
      title: seriesRow.title,
      location: seriesRow.location,
    },
    overridesByOriginalStart,
    windowStart,
    windowEnd,
  );

  const rowsToUpsert = occurrences.map((occurrence) => ({
    id: `${seriesRow.id}@${occurrence.originalStart.toISOString()}`,
    userId: seriesRow.userId,
    calendarId: seriesRow.calendarId,
    seriesId: seriesRow.id,
    originalStart: occurrence.originalStart,
    startAt: occurrence.start,
    endAt: occurrence.end,
    allDay: seriesRow.allDay,
    tzid: seriesRow.tzid,
    floating: seriesRow.floating,
    title: occurrence.title,
    location: occurrence.location,
    status: "confirmed" as const,
    transparency: seriesRow.transparency,
    updatedAt: new Date(),
  }));
  const validIds = new Set(rowsToUpsert.map((row) => row.id));

  if (rowsToUpsert.length > 0) {
    await db
      .insert(events)
      .values(rowsToUpsert)
      .onConflictDoUpdate({
        target: events.id,
        // Multi-row upsert: each conflicting row must take *its own*
        // proposed values, not the first row's — `excluded.*` (not a plain
        // field reference, which would apply one static value to every
        // conflicting row alike).
        set: {
          originalStart: sql`excluded.original_start`,
          startAt: sql`excluded.start_at`,
          endAt: sql`excluded.end_at`,
          allDay: sql`excluded.all_day`,
          tzid: sql`excluded.tzid`,
          floating: sql`excluded.floating`,
          title: sql`excluded.title`,
          location: sql`excluded.location`,
          transparency: sql`excluded.transparency`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  const existingRows: Pick<EventRow, "id">[] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.seriesId, seriesRow.id));
  const idsToDestroy = existingRows.map((row) => row.id).filter((id) => !validIds.has(id));

  if (idsToDestroy.length > 0) {
    await db.delete(events).where(inArray(events.id, idsToDestroy));
    await recordTombstones(db, {
      mailAccountId: null,
      collection: "Event",
      entityIds: idsToDestroy,
    });
  }

  await rebuildReminderDueForRematerialisedSeries(db, seriesRow);
}

/**
 * `rematerialiseSeries`'s own trailer (#245, ADR-0028): "rebuilt whenever
 * the Series, its Overrides... change... and rolled forward daily" is
 * exactly the set of things that already call `rematerialiseSeries` above —
 * every Series/Override structural mutation, plus the daily Materialisation
 * Window roll (`materialise-loop.ts`) — so hooking the Reminder Due rebuild
 * in here, rather than at each of those call sites individually, is what
 * makes the two tables impossible to drift apart by a forgotten call site.
 * A Calendar gone missing (should never happen — every Series has one) is a
 * silent no-op, the same tolerance `enqueueOutboxIfMirrored` gives it.
 */
async function rebuildReminderDueForRematerialisedSeries(
  db: Db,
  seriesRow: SeriesRow,
): Promise<void> {
  const [calendarRow] = await db
    .select()
    .from(calendars)
    .where(eq(calendars.id, seriesRow.calendarId));
  if (!calendarRow) return;
  const [userRow] = await db
    .select({ homeTimeZone: users.homeTimeZone })
    .from(users)
    .where(eq(users.id, seriesRow.userId));
  await rebuildReminderDueForSeries(
    db,
    seriesRow,
    calendarRow,
    userRow?.homeTimeZone ?? HOME_TIME_ZONE_UNSET,
  );
}

/** `<seriesId>@<instance host>` (ADR-0025) — the one place a fresh Series' `uid` is minted, so `createSeriesSkeleton`/`applySeriesSave`'s own lazy-create both derive the same value for the same id. */
function seriesUid(seriesId: string): string {
  return `${seriesId}@${hostname()}`;
}

/** Deletes every Occurrence a Series currently has materialised and tombstones them — `mirror-discard.ts#discardMirroredEvents`'s own shape, scoped to one Series rather than a whole Calendar. Used by `trashSeries` so a soft-deleted Series' Occurrences disappear from the grid at once, not on the next daily sweep. */
async function destroySeriesOccurrences(db: Db, seriesId: string): Promise<void> {
  const rows = await db.select({ id: events.id }).from(events).where(eq(events.seriesId, seriesId));
  if (rows.length === 0) return;
  await db.delete(events).where(eq(events.seriesId, seriesId));
  await recordTombstones(db, {
    mailAccountId: null,
    collection: "Event",
    entityIds: rows.map((row) => row.id),
  });
}

/**
 * `createSeries`'s own store call (`sync/mutations.ts`): inserts the empty
 * skeleton row a `seriesSaves` write will fill in moments later — `notes
 * .ts#applyUserIntent`'s own `createNote` shape, `onConflictDoNothing`
 * absorbing both a retried mutation id and a `seriesSaves` write that raced
 * ahead of this one and already lazily created the row (`applySeriesSave`
 * below). Rejects `calendar_not_found` for a `calendarId` this User does not
 * own — the one guard a skeleton insert needs before it can go on to
 * accept a body it has nowhere real to belong to.
 */
export async function createSeriesSkeleton(
  db: Db,
  userId: string,
  seriesId: string,
  calendarId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [calendar] = await db
    .select({ id: calendars.id })
    .from(calendars)
    .where(and(eq(calendars.id, calendarId), eq(calendars.userId, userId)));
  if (!calendar) return { ok: false, reason: "calendar_not_found" };

  await db
    .insert(series)
    .values({
      id: seriesId,
      userId,
      calendarId,
      uid: seriesUid(seriesId),
      title: "",
      allDay: false,
      floating: false,
      dtstart: new Date(),
      durationMs: 0,
      transparency: "opaque",
    })
    .onConflictDoNothing({ target: series.id });
  return { ok: true };
}

/** `deleteSeries`'s own store call — the permanent, real inverse of `createSeries` (ADR-0019): tears down whatever Occurrences the Series has materialised and physically removes the `series`/`overrides` rows (cascade). A Series already gone (Undo racing a second delete, or a retried mutation id) is a harmless no-op, the same tolerance `deleteNote` gives. */
export async function deleteSeriesPermanently(
  db: Db,
  userId: string,
  seriesId: string,
): Promise<void> {
  await destroySeriesOccurrences(db, seriesId);
  await db.delete(series).where(and(eq(series.id, seriesId), eq(series.userId, userId)));
}

async function seriesRow(db: Db, userId: string, seriesId: string): Promise<SeriesRow | null> {
  const [row] = await db
    .select()
    .from(series)
    .where(and(eq(series.id, seriesId), eq(series.userId, userId)));
  return row ?? null;
}

/**
 * Soft-deletes a Series (#233's "Delete" — not `deleteSeries`'s permanent
 * create-undo above): sets `deletedAt` and tears down its Occurrences at
 * once, the same synchronous-ack shape `archive`/`trash` give a Thread. The
 * row (and its Overrides) stay exactly as they were — the 24-hour snapshot
 * `restoreSeries` reads back from is nothing more than this same row with
 * `deletedAt` cleared.
 */
export async function trashSeries(
  db: Db,
  userId: string,
  seriesId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await seriesRow(db, userId, seriesId);
  if (!row) return { ok: false, reason: "series_not_found" };
  if (row.deletedAt === null) {
    await db
      .update(series)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(series.id, seriesId));
    await destroySeriesOccurrences(db, seriesId);
    await enqueueOutboxIfMirrored(db, userId, row, "cancel");
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, row.calendarId));
    if (calendarRow) await sendOrganizerCancelForWholeSeries(db, userId, calendarRow, row);
  }
  return { ok: true };
}

/** The real inverse of `trashSeries`: clears `deletedAt` and immediately re-materialises the Series over the current Materialisation Window, so its Occurrences come back in the very same round trip rather than waiting for the next daily sweep. A Series not currently trashed (Undo racing a purge, or a retried mutation id) is a harmless no-op. */
export async function restoreSeries(
  db: Db,
  userId: string,
  seriesId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await seriesRow(db, userId, seriesId);
  if (!row) return { ok: false, reason: "series_not_found" };
  if (row.deletedAt !== null) {
    await db
      .update(series)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(series.id, seriesId));
    const window = computeMaterialisationWindow();
    await rematerialiseSeries(db, { ...row, deletedAt: null }, window.start, window.end);
    await enqueueOutboxIfMirrored(db, userId, row, "restore");
  }
  return { ok: true };
}

/**
 * Deletes one Occurrence (#233's own acceptance line: "Deleting one
 * Occurrence adds an `exdate` and nothing more") and its real inverse,
 * `removeExdate`, below (ADR-0019). Both re-materialise immediately so the
 * grid reflects the change in the same round trip. A duplicate `exdate` (a
 * retried mutation id) is absorbed rather than appended twice.
 */
export async function addExdate(
  db: Db,
  userId: string,
  seriesId: string,
  exdate: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await seriesRow(db, userId, seriesId);
  if (!row) return { ok: false, reason: "series_not_found" };
  if (!row.exdates.includes(exdate)) {
    const nextExdates = [...row.exdates, exdate];
    await db
      .update(series)
      .set({ exdates: nextExdates, updatedAt: new Date() })
      .where(eq(series.id, seriesId));
    const window = computeMaterialisationWindow();
    const nextRow = { ...row, exdates: nextExdates };
    await rematerialiseSeries(db, nextRow, window.start, window.end);
    await enqueueOutboxIfMirrored(db, userId, row, "upsert");
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, row.calendarId));
    if (calendarRow) {
      await sendOrganizerOccurrenceCancel(db, userId, calendarRow, nextRow, exdate);
    }
  }
  return { ok: true };
}

/** The real inverse of `addExdate` — removes one `exdate` entry and re-materialises. An `exdate` no longer present (Undo racing a further edit, or a retried mutation id) is a harmless no-op. */
export async function removeExdate(
  db: Db,
  userId: string,
  seriesId: string,
  exdate: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await seriesRow(db, userId, seriesId);
  if (!row) return { ok: false, reason: "series_not_found" };
  if (row.exdates.includes(exdate)) {
    const nextExdates = row.exdates.filter((entry) => entry !== exdate);
    await db
      .update(series)
      .set({ exdates: nextExdates, updatedAt: new Date() })
      .where(eq(series.id, seriesId));
    const window = computeMaterialisationWindow();
    await rematerialiseSeries(db, { ...row, exdates: nextExdates }, window.start, window.end);
    await enqueueOutboxIfMirrored(db, userId, row, "upsert");
  }
  return { ok: true };
}

/**
 * Answers an Invitation whose `UID` matches this Series, on a synced
 * Calendar (#240, ADR-0027): rewrites this Series' own attendee entry for
 * the address the Calendar's own Connected Account mirrors and pushes it
 * upstream as `operation: "respond"` — the outbox row Google folds into
 * the same full-body `PATCH` any other `upsert` sends (`event-body.ts
 * #toGoogleAttendees` now carries `responseStatus`, so the write itself
 * needs no special casing there) and Graph turns into its own dedicated
 * `accept`/`decline`/`tentativelyAccept` action (`graph/outbox-processor
 * .ts`) — either way, the upstream is what actually sends the `REPLY`,
 * never Wicket itself (ADR-0027's own acceptance line).
 *
 * The self address is derived here, from the Calendar being answered on —
 * never taken from the caller — the same "the address decides everything"
 * rule ADR-0027 gives an Invitation's own routing: a Client cannot ask this
 * to flip an arbitrary attendee's `responseStatus` by naming a different
 * address.
 *
 * Rejects `not_synced` for a Local Calendar's Series — this ticket's own
 * scope line, "no Calendar choice, the mirror already shows the Event";
 * #241 answers that path instead. `not_attendee` covers an Invitation whose
 * `attendees` never actually named this Mail Account's address (a forwarded
 * invite, or a stale mirror) — nothing here invents an attendee row that
 * was never on the Series to begin with.
 *
 * Returns the attendee's *previous* `responseStatus` so the caller (the
 * Reader card's Undo) can answer again with that value — a real inverse
 * (ADR-0019) rather than a queue cancellation, and the one place the Client
 * learns whether Undo is even offered: `"needsAction"` (a first Answer) is
 * the value neither Google nor Graph's `REPLY` shape can express back
 * (ADR-0027), so a caller seeing it back should offer no Undo at all.
 */
export async function answerInvitation(
  db: Db,
  userId: string,
  seriesId: string,
  responseStatus: "accepted" | "declined" | "tentative",
): Promise<
  | { ok: true; previousResponseStatus: SeriesRow["attendees"][number]["responseStatus"] }
  | { ok: false; reason: "series_not_found" | "not_synced" | "not_attendee" }
> {
  const row = await seriesRow(db, userId, seriesId);
  if (!row) return { ok: false, reason: "series_not_found" };

  const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, row.calendarId));
  if (calendarRow?.originType !== "connectedAccount") {
    return { ok: false, reason: "not_synced" };
  }
  const [mailAccountRow] = await db
    .select({ emailAddress: mailAccounts.emailAddress })
    .from(mailAccounts)
    .where(eq(mailAccounts.connectedAccountId, calendarRow.connectedAccountId ?? ""));
  if (!mailAccountRow) return { ok: false, reason: "not_synced" };

  const normalized = mailAccountRow.emailAddress.trim().toLowerCase();
  const index = row.attendees.findIndex(
    (attendee) => attendee.email.trim().toLowerCase() === normalized,
  );
  if (index === -1) return { ok: false, reason: "not_attendee" };

  const previousResponseStatus = row.attendees[index]?.responseStatus ?? "needsAction";
  const nextAttendees = row.attendees.map((attendee, i) =>
    i === index ? { ...attendee, responseStatus } : attendee,
  );

  await db
    .update(series)
    .set({ attendees: nextAttendees, updatedAt: new Date() })
    .where(eq(series.id, seriesId));
  await enqueueOutboxIfMirrored(db, userId, row, "respond", true, responseStatus);

  return { ok: true, previousResponseStatus };
}

/**
 * Applies one `seriesSaves` write (#233, `series.ts#seriesSaveSchema`'s own
 * doc comment): upserts the Series' whole body, replaces its whole Override
 * set, then re-materialises immediately over the current Materialisation
 * Window — the grid reflects a create or an edit in the very same round
 * trip a `noteSaves` write reflects a body edit in, never waiting for the
 * next daily sweep.
 *
 * Created lazily if somehow missing (`note-store.ts#applyOne`'s own
 * tolerance): a `createSeries` intent and this save are two separate arrays
 * on one `POST /sync` request, so nothing promises the skeleton lands
 * first. A row belonging to a *different* User is left untouched, the same
 * one guard `note-store.ts#applyOne` keeps despite "lazily creates".
 */
export async function applySeriesSave(db: Db, userId: string, save: SeriesSave): Promise<void> {
  const [existing] = await db.select().from(series).where(eq(series.id, save.id));
  if (existing && existing.userId !== userId) return;

  const values = {
    id: save.id,
    userId,
    calendarId: save.calendarId,
    uid: seriesUid(save.id),
    title: save.title,
    description: save.description,
    location: save.location,
    allDay: save.allDay,
    floating: save.floating,
    tzid: save.tzid,
    dtstart: new Date(save.dtstart),
    durationMs: save.durationMs,
    rrules: save.rrules,
    rdates: save.rdates,
    exdates: save.exdates,
    transparency: save.transparency,
    attendees: save.attendees,
    reminders: save.reminders,
    updatedAt: new Date(),
  };

  if (!existing) {
    await db.insert(series).values(values).onConflictDoUpdate({
      target: series.id,
      set: values,
    });
  } else {
    await db.update(series).set(values).where(eq(series.id, save.id));
  }

  await db.delete(overrides).where(eq(overrides.seriesId, save.id));
  if (save.overrides.length > 0) {
    await db.insert(overrides).values(
      save.overrides.map((override) => ({
        id: override.id,
        seriesId: save.id,
        originalStart: new Date(override.originalStart),
        start: override.start ? new Date(override.start) : null,
        end: override.end ? new Date(override.end) : null,
        title: override.title,
        location: override.location,
      })),
    );
  }

  const [row] = await db.select().from(series).where(eq(series.id, save.id));
  if (row && row.deletedAt === null) {
    const window = computeMaterialisationWindow();
    await rematerialiseSeries(db, row, window.start, window.end);
    await enqueueOutboxIfMirrored(db, userId, row, "upsert");
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, row.calendarId));
    if (calendarRow) {
      await sendOrganizerUpdates(
        db,
        userId,
        calendarRow,
        existing ?? null,
        row,
        save.sendUpdate ?? true,
      );
    }
  }
}

/** Every un-deleted Series a Materialise sweep should visit (`materialise-loop.ts`) — a soft-deleted one (`trashSeries`) already had its Occurrences torn down and stays torn down until `restoreSeries` brings it back. */
export async function selectMaterialisableSeries(db: Db): Promise<SeriesRow[]> {
  return db.select().from(series).where(isNull(series.deletedAt));
}

/**
 * Whether two Calendars are close enough in Origin for a Move between them
 * (#238's own acceptance line: "Same-Origin moves and moves to a Local
 * Calendar are offered; cross-Connected-Account moves are hidden"). `false`
 * only when both are mirrored Connected-Account Calendars belonging to
 * *different* accounts — Local↔Local, Local↔mirrored, and two Calendars of
 * the *same* Connected Account are all fine.
 */
function canMoveBetweenCalendars(from: CalendarRow, to: CalendarRow): boolean {
  if (from.originType !== "connectedAccount" || to.originType !== "connectedAccount") return true;
  return from.connectedAccountId === to.connectedAccountId;
}

/**
 * Moves a Series to a different Calendar (#238): "no upstream lets a
 * calendar object change container while keeping identity", so this is a
 * copy plus delete with a fresh UID, never an in-place `calendarId` update —
 * the same "this and following" split (`EventEditorPopover.tsx`) already
 * uses a brand-new `series.id`/`uid` for a genuinely new object. `newSeriesId`
 * is Client-minted (`newSeriesId`'s own shape, `store/series.ts`), exactly
 * like `createSeries`'s own `seriesId`.
 *
 * The destination row copies the whole body and every Override (this
 * ticket's own acceptance line: "carries its Overrides and `exdates`") but
 * never `upstreamId`/`etag`/`upstreamSnapshot` — those name a specific
 * upstream object this Move is deliberately not re-using. The source row is
 * soft-deleted exactly like `trashSeries` (occurrences torn down at once),
 * except it enqueues no outbox write of its own: `enqueueOutboxWrite`'s
 * `operation: "move"` below carries *both* Calendars' halves as one push
 * (`outbox-processor.ts`), so the cancel-old and insert-new sides fail (and
 * roll back) together rather than as two independently-retried rows.
 */
export async function moveSeries(
  db: Db,
  userId: string,
  seriesId: string,
  newSeriesId: string,
  calendarId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await seriesRow(db, userId, seriesId);
  if (!row) return { ok: false, reason: "series_not_found" };
  if (row.deletedAt !== null) {
    // Already moved (a retried mutation id) is a harmless no-op, the same
    // tolerance every other structural mutation gives; a Series trashed some
    // other way — deleted, or already moved elsewhere — has nothing left
    // this particular `newSeriesId` can move.
    const [alreadyMoved] = await db
      .select({ id: series.id })
      .from(series)
      .where(eq(series.id, newSeriesId));
    return alreadyMoved ? { ok: true } : { ok: false, reason: "series_not_found" };
  }
  if (row.calendarId === calendarId) return { ok: true }; // Already there — a harmless no-op.

  const [fromCalendar] = await db
    .select()
    .from(calendars)
    .where(and(eq(calendars.id, row.calendarId), eq(calendars.userId, userId)));
  const [toCalendar] = await db
    .select()
    .from(calendars)
    .where(and(eq(calendars.id, calendarId), eq(calendars.userId, userId)));
  if (!fromCalendar || !toCalendar) return { ok: false, reason: "calendar_not_found" };
  if (!canMoveBetweenCalendars(fromCalendar, toCalendar)) {
    return { ok: false, reason: "cross_account_move_not_supported" };
  }

  const overrideRows = await db.select().from(overrides).where(eq(overrides.seriesId, seriesId));

  const now = new Date();
  const newRow: typeof series.$inferInsert = {
    id: newSeriesId,
    userId,
    calendarId,
    uid: seriesUid(newSeriesId),
    sequence: 0,
    title: row.title,
    description: row.description,
    location: row.location,
    allDay: row.allDay,
    floating: row.floating,
    tzid: row.tzid,
    dtstart: row.dtstart,
    durationMs: row.durationMs,
    rrules: row.rrules,
    rdates: row.rdates,
    exdates: row.exdates,
    transparency: row.transparency,
    attendees: row.attendees,
    // A moved Series carries its own Reminders with it (#245, ADR-0028) — a
    // "move" is "copy plus delete with a fresh UID" (`calendar_outbox
    // .operation`'s own doc comment), never a reset to the Calendar's
    // default the way silently dropping this field would produce.
    reminders: row.reminders,
    upstreamId: null,
    etag: null,
    upstreamSnapshot: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(series).values(newRow).onConflictDoNothing({ target: series.id });

  if (overrideRows.length > 0) {
    await db
      .insert(overrides)
      .values(
        overrideRows.map((override) => ({
          id: `${newSeriesId}:${override.id}`,
          seriesId: newSeriesId,
          originalStart: override.originalStart,
          start: override.start,
          end: override.end,
          title: override.title,
          location: override.location,
        })),
      )
      .onConflictDoNothing({ target: overrides.id });
  }

  const window = computeMaterialisationWindow();
  await rematerialiseSeries(db, newRow as SeriesRow, window.start, window.end);

  // The source row, soft-deleted like `trashSeries` — but no outbox write of
  // its own; the single `move` push below carries both halves. Any write this
  // Series still had queued (a body save's own "upsert", say) is superseded
  // outright: the `move` push is the whole story for this Move, so a stale
  // row under the *old* id would otherwise sit there and eventually re-push a
  // Series that no longer has anywhere it belongs.
  await db.update(series).set({ deletedAt: now, updatedAt: now }).where(eq(series.id, seriesId));
  await destroySeriesOccurrences(db, seriesId);
  await db.delete(calendarOutbox).where(eq(calendarOutbox.seriesId, seriesId));

  if (shouldPushUpstream(fromCalendar) || shouldPushUpstream(toCalendar)) {
    await enqueueOutboxWrite(db, {
      userId,
      calendarId,
      seriesId: newSeriesId,
      operation: "move",
      sendInvitations: true,
      moveFromSeriesId: seriesId,
    });
  }

  return { ok: true };
}
