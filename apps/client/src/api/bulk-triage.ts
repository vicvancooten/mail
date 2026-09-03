import {
  type BulkTriageBatchRequest,
  type BulkTriageBatchResponse,
  type BulkTriageCountRequest,
  type BulkTriageCountResponse,
  type BulkTriageUndoRequest,
  type BulkTriageUndoResponse,
  bulkTriageBatchResponseSchema,
  bulkTriageCountResponseSchema,
  bulkTriageUndoResponseSchema,
} from "@mail/shared";
import { postJson } from "./auth.js";

/**
 * `POST /bulk-triage/{count,batch,undo}` (#67, #77 "Group header cluster").
 * Stateless action/query calls, the same shape `api/search.ts`'s
 * `runServerSearch` already uses — deliberately outside `POST /sync`'s delta
 * protocol (see `@mail/shared`'s `bulk-triage.ts`), so a plain authenticated
 * `POST` here rather than another entry in `sync/`.
 */

/** "How many Threads are in this group" — the group header's true total (#77's "shows the group's true total, not the loaded count"). */
export function countBulkTriageTarget(
  request: BulkTriageCountRequest,
): Promise<BulkTriageCountResponse> {
  return postJson("/bulk-triage/count", request, (data) =>
    bulkTriageCountResponseSchema.parse(data),
  );
}

/** Done all / Mark all read on a whole target set. */
export function runBulkTriageBatch(
  request: BulkTriageBatchRequest,
): Promise<BulkTriageBatchResponse> {
  return postJson("/bulk-triage/batch", request, (data) =>
    bulkTriageBatchResponseSchema.parse(data),
  );
}

/** Reverses one batch, within its Undo window. */
export function undoBulkTriageBatch(
  request: BulkTriageUndoRequest,
): Promise<BulkTriageUndoResponse> {
  return postJson("/bulk-triage/undo", request, (data) => bulkTriageUndoResponseSchema.parse(data));
}
