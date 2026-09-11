import { SERIES_TRASH_RETENTION_HOURS } from "@mail/shared";
import { and, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { series } from "../db/schema.js";

/**
 * The 24-hour snapshot's own purge sweep (#233's own acceptance line —
 * `sync/note-purge.ts`'s shape, scoped to `series` instead of `notes`). A
 * soft-deleted Series (`series-store.ts#trashSeries`) already tore down its
 * Occurrences and tombstoned them at delete time — this only ever removes
 * the now-stale `series`/`overrides` rows themselves (cascade), once the
 * window `restoreSeries` could still have brought them back in has passed.
 * No tombstone to record here: a Series never rode `POST /sync`
 * (`series.ts#seriesSchema`'s own doc comment), so there is no Client-side
 * row for one to tell an open Client to drop.
 */
export async function purgeExpiredSeries(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SERIES_TRASH_RETENTION_HOURS * 60 * 60 * 1000);
  const purged = await db
    .delete(series)
    .where(and(isNotNull(series.deletedAt), lte(series.deletedAt, cutoff)))
    .returning({ id: series.id });
  return purged.length;
}
