import { count, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { events } from "../db/schema.js";
import { recordTombstones } from "../sync/tombstones.js";

/**
 * What unmirroring a Calendar actually throws away (#235's own acceptance
 * line: "Unmirroring discards that Calendar's mirror at once — Series,
 * Overrides, Occurrences, its Reminder Due rows and its outbox entries").
 * Only `events` (Occurrences) counts today: Series, Overrides, Reminder
 * Due rows and the write-back outbox are #230's/#237's tables, none of
 * which exist on this branch's ancestry yet (`db/schema.ts`'s own
 * "always empty on this line" doc comments on `events`/`rollbacks`) — the
 * same kind of deferral #234's closing comment already made for the
 * Connected Account table. This type is additive: a future Series/Override
 * table adds a field here, not a reshape.
 */
export interface DiscardedMirrorCounts {
  events: number;
}

/**
 * Deletes every Occurrence a Calendar's mirror holds and tombstones them
 * (ADR-0011's `destroyed` list) so an open Client's next delta actually
 * drops them, rather than relying only on `events.calendarId`'s FK cascade
 * — that cascade fires if the Calendar row itself is later deleted, but
 * unmirroring keeps the row (this ticket's own acceptance line: "the row
 * kept so it can be re-mirrored later"), so nothing else would ever tell
 * the Client these rows are gone.
 *
 * Called from within the same transaction that flips `mirrored` to
 * `false` (`calendars/store.ts#unmirrorCalendar`) — an unmirror is
 * immediate and un-undoable, never a partial discard left for a retry.
 */
export async function discardMirroredEvents(
  db: Db | Tx,
  calendarId: string,
): Promise<DiscardedMirrorCounts> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.calendarId, calendarId));
  if (rows.length === 0) return { events: 0 };

  const ids = rows.map((row) => row.id);
  await db.delete(events).where(eq(events.calendarId, calendarId));
  await recordTombstones(db, { mailAccountId: null, collection: "Event", entityIds: ids });
  return { events: ids.length };
}

/**
 * A read-only preview of `discardMirroredEvents`' own counts — what the
 * confirm dialog shows before the User commits to unmirroring (#235's own
 * acceptance line: "confirmed with counts"). Never mutates anything, so it
 * can be called freely while the dialog is open without racing the actual
 * discard.
 */
export async function countMirroredEvents(
  db: Db,
  calendarId: string,
): Promise<DiscardedMirrorCounts> {
  const [row] = await db
    .select({ total: count() })
    .from(events)
    .where(eq(events.calendarId, calendarId));
  return { events: row?.total ?? 0 };
}
