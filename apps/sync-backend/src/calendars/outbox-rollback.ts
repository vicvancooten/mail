import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { rollbacks, type SeriesRow, series } from "../db/schema.js";
import { computeMaterialisationWindow } from "./materialise-loop.js";
import { rematerialiseSeries } from "./series-store.js";

/**
 * ADR-0025's conflict resolution, all three shapes alike (an upstream
 * rejection, a failed conditional write, a delta that already moved the
 * Series' `etag` out from under a queued write): "refetch, revert the
 * mirror from its `upstreamSnapshot` (no network needed), drop the queued
 * write, merge nothing." `outbox-processor.ts` is this function's only
 * caller — always paired with `writeRollback` and dropping (deleting) the
 * outbox row, never one without the other two.
 *
 * A Series with no `upstreamSnapshot` yet (its very first push, rejected
 * before anything ever landed upstream) has nothing to revert *to* — there
 * is no "the way Google had it" for a row Google never accepted. The
 * honest revert there is the same "a wrong merge is worse than a visible
 * loss the User can redo" ADR-0025 argues for: soft-delete the Series
 * (`trashSeries`'s own shape) rather than leave a local-only row that will
 * never sync upstream and never says so.
 */
export async function revertSeriesFromUpstreamSnapshot(
  db: Db,
  seriesRow: SeriesRow,
): Promise<void> {
  const snapshot = seriesRow.upstreamSnapshot as
    | (Pick<
        SeriesRow,
        | "title"
        | "description"
        | "location"
        | "allDay"
        | "floating"
        | "tzid"
        | "durationMs"
        | "rrules"
        | "rdates"
        | "exdates"
        | "transparency"
        | "attendees"
        | "reminders"
        | "upstreamId"
        | "etag"
      > & { dtstart: string })
    | null
    | undefined;

  if (!snapshot) {
    await db
      .update(series)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(series.id, seriesRow.id));
    return;
  }

  const reverted: SeriesRow = {
    ...seriesRow,
    title: snapshot.title,
    description: snapshot.description,
    location: snapshot.location,
    allDay: snapshot.allDay,
    floating: snapshot.floating,
    tzid: snapshot.tzid,
    dtstart: new Date(snapshot.dtstart),
    durationMs: snapshot.durationMs,
    rrules: snapshot.rrules,
    rdates: snapshot.rdates,
    exdates: snapshot.exdates,
    transparency: snapshot.transparency,
    attendees: snapshot.attendees,
    reminders: snapshot.reminders,
    upstreamId: snapshot.upstreamId,
    etag: snapshot.etag,
    updatedAt: new Date(),
  };
  await db
    .update(series)
    .set({
      title: reverted.title,
      description: reverted.description,
      location: reverted.location,
      allDay: reverted.allDay,
      floating: reverted.floating,
      tzid: reverted.tzid,
      dtstart: reverted.dtstart,
      durationMs: reverted.durationMs,
      rrules: reverted.rrules,
      rdates: reverted.rdates,
      exdates: reverted.exdates,
      transparency: reverted.transparency,
      attendees: reverted.attendees,
      reminders: reverted.reminders,
      upstreamId: reverted.upstreamId,
      etag: reverted.etag,
      updatedAt: reverted.updatedAt,
    })
    .where(eq(series.id, seriesRow.id));

  if (reverted.deletedAt === null) {
    const window = computeMaterialisationWindow();
    await rematerialiseSeries(db, reverted, window.start, window.end);
  }
}

/**
 * A rejected `move` push's own revert (#238) — `outbox-processor.ts#reject`'s
 * one special case: `seriesRow` (the destination Series `enqueueOutboxWrite`
 * keyed the `move` row to) is dropped exactly like any other never-confirmed
 * Series (`revertSeriesFromUpstreamSnapshot` with no snapshot yet — it has
 * one only after a push actually lands, which this one never did), and the
 * source Series (`moveFromSeriesId`) is restored the same way `restoreSeries`
 * restores any other soft-deleted row. Returns the id the Rollback row should
 * name — the source Series, since that's what the User sees reappear; the
 * destination id if there is no source row left to restore (a Series-purge
 * sweep raced a very slow retry past `moveFromSeriesId`'s own `onDelete: "set
 * null"` — nothing to revert to, so the honest answer is "the Move itself is
 * gone", named by its own destination id).
 */
export async function revertMoveFailure(
  db: Db,
  destinationRow: SeriesRow,
  moveFromSeriesId: string | null,
): Promise<string> {
  await revertSeriesFromUpstreamSnapshot(db, destinationRow);

  if (moveFromSeriesId) {
    const [sourceRow] = await db.select().from(series).where(eq(series.id, moveFromSeriesId));
    if (sourceRow && sourceRow.deletedAt !== null) {
      await db
        .update(series)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(series.id, moveFromSeriesId));
      const window = computeMaterialisationWindow();
      await rematerialiseSeries(db, { ...sourceRow, deletedAt: null }, window.start, window.end);
      return moveFromSeriesId;
    }
    if (sourceRow) return moveFromSeriesId;
  }
  return destinationRow.id;
}

/** One `Rollback` row (#229/#237, ADR-0025) — the Client-visible "this was reverted" fact, `collection` always `"Series"` here since a Series' body is what an outbox push carries. */
export async function writeRollback(
  db: Db,
  params: { userId: string; entityId: string; reason: string | null },
  now: Date = new Date(),
): Promise<void> {
  await db.insert(rollbacks).values({
    id: randomUUID(),
    userId: params.userId,
    collection: "Series",
    entityId: params.entityId,
    reason: params.reason,
    occurredAt: now,
  });
}
