import type { Rollback } from "@mail/shared";
import type { RollbackRow } from "../db/schema.js";

/** Maps a stored Rollback row to ADR-0011/ADR-0025's wire projection. Unused until #237's outbox inserts a row. */
export function toWireRollback(row: RollbackRow): Rollback {
  return {
    id: row.id,
    userId: row.userId,
    collection: row.collection,
    entityId: row.entityId,
    reason: row.reason,
    occurredAt: row.occurredAt.toISOString(),
  };
}
