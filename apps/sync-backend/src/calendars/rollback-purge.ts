import { and, inArray, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { rollbacks } from "../db/schema.js";
import { recordTombstones } from "../sync/tombstones.js";

/** ADR-0025's own retention: "tombstoned after seven days" — `Rollback`'s own doc comment (`packages/shared/src/rollback.ts`). */
export const ROLLBACK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The Rollback collection's own purge sweep (#237) — `sync/note-purge.ts`'s
 * shape: unlike `series-purge.ts` (a Series never rode `POST /sync`, so
 * there is no Client row to tell about), `rollbacks` **is** an ADR-0011
 * collection (`sync/collection-registry.ts`), so a purge here must
 * tombstone, the same as any other collection's deletion.
 */
export async function purgeExpiredRollbacks(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ROLLBACK_RETENTION_MS);
  const rows = await db
    .select({ id: rollbacks.id, userId: rollbacks.userId })
    .from(rollbacks)
    .where(and(lte(rollbacks.occurredAt, cutoff)));
  if (rows.length === 0) return 0;

  const byUser = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byUser.get(row.userId) ?? [];
    ids.push(row.id);
    byUser.set(row.userId, ids);
  }
  await db.delete(rollbacks).where(
    inArray(
      rollbacks.id,
      rows.map((row) => row.id),
    ),
  );
  for (const [, entityIds] of byUser) {
    // `Rollback` is User-scoped (`sync/collection-registry.ts`), so its
    // tombstone rides the same `mailAccountId: null` shape
    // `series-store.ts#rematerialiseSeries`'s Event tombstones already use
    // for a User-scoped collection.
    await recordTombstones(db, { mailAccountId: null, collection: "Rollback", entityIds });
  }
  return rows.length;
}
