import {
  BULK_TRIAGE_RESET_THRESHOLD,
  BULK_TRIAGE_UNDO_WINDOW_SECONDS,
  type BulkTriageAccountOutcome,
  bulkTriageBatchRequestSchema,
  bulkTriageBatchResponseSchema,
  bulkTriageCountRequestSchema,
  bulkTriageCountResponseSchema,
  bulkTriageUndoRequestSchema,
  bulkTriageUndoResponseSchema,
} from "@mail/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { type BulkTriageAccountOutcomeRow, bulkTriageBatches } from "../db/schema.js";
import { bumpThreadsEpoch, getMailAccountForUser } from "../mail-accounts/store.js";
import {
  applyBulkTriageAction,
  countTargetThreads,
  selectTargetThreadIds,
  undoBulkTriageAction,
} from "../sync/bulk-triage.js";
import { isUniqueViolation } from "../sync/mutations.js";

export interface BulkTriageRoutesOptions {
  db: Db;
}

/**
 * The Bulk Triage batch endpoints (#67, part of #66's Group bulk Triage):
 * `POST /bulk-triage/count` answers "how many Threads are in this group";
 * `POST /bulk-triage/batch` does **Done all** / **Mark all read** against a
 * target set of **date range + folder + Account Scope**; `POST
 * /bulk-triage/undo` reverses one within its Undo window. See
 * `@mail/shared`'s `bulk-triage.ts` for the wire contract and
 * `sync/bulk-triage.ts` for the per-account query/mutation logic this route
 * only dispatches to.
 */
export async function bulkTriageRoutes(app: FastifyInstance, { db }: BulkTriageRoutesOptions) {
  app.post("/bulk-triage/count", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = bulkTriageCountRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const userId = requireUser(request).id;
    const target = parsed.data;
    const now = new Date();
    const until = clampUntil(target.until, now);
    const since = target.since ? new Date(target.since) : null;

    let count = 0;
    for (const mailAccountId of target.accountScope) {
      // Silently skipped, same as `POST /sync`'s own handling of a Mail
      // Account id the Client still has cached but no longer owns: an
      // account the User doesn't have is not counted, never a 403/404 that
      // would abort the whole multi-account count.
      const account = await getMailAccountForUser(db, userId, mailAccountId);
      if (!account) continue;
      count += await countTargetThreads(db, {
        mailAccountId,
        folderRole: target.folderRole,
        since,
        until,
      });
    }

    return bulkTriageCountResponseSchema.parse({ count });
  });

  app.post("/bulk-triage/batch", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = bulkTriageBatchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const userId = requireUser(request).id;
    const { id, action, target } = parsed.data;

    const existing = await batchRow(db, id);
    if (existing) return bulkTriageBatchResponseSchema.parse(toBatchResponse(existing));

    // One "now" for the whole batch: every in-scope Mail Account's target set
    // is evaluated against the same instant, so a partial failure never
    // reports two accounts as having answered two different requests.
    const now = new Date();
    const until = clampUntil(target.until, now);
    const since = target.since ? new Date(target.since) : null;

    const accounts: BulkTriageAccountOutcome[] = [];
    const affectedThreadIds: string[] = [];

    for (const mailAccountId of target.accountScope) {
      const account = await getMailAccountForUser(db, userId, mailAccountId);
      if (!account) {
        accounts.push({
          mailAccountId,
          status: "rejected",
          affectedCount: 0,
          reason: "mail_account_not_found",
        });
        continue;
      }
      // ADR-0006's Needs Reauth posture: queued work holds rather than
      // fails, but a batch has no queue to hold it in, so it is reported
      // rejected outright — exactly the "Done for 2 of 3 accounts —
      // Personal needs reauth" partial failure #67 asks for.
      if (account.status === "needs_reauth") {
        accounts.push({
          mailAccountId,
          status: "rejected",
          affectedCount: 0,
          reason: "needs_reauth",
        });
        continue;
      }

      const threadIds = await selectTargetThreadIds(db, {
        mailAccountId,
        folderRole: target.folderRole,
        since,
        until,
      });
      if (threadIds.length > 0) {
        await applyBulkTriageAction(db, mailAccountId, action, threadIds);
        if (threadIds.length > BULK_TRIAGE_RESET_THRESHOLD) {
          await bumpThreadsEpoch(db, mailAccountId);
        }
      }
      affectedThreadIds.push(...threadIds);
      accounts.push({ mailAccountId, status: "applied", affectedCount: threadIds.length });
    }

    const row = await insertBatchRow(db, {
      id,
      userId,
      action,
      affectedThreadIds,
      accounts,
      createdAt: now,
    });

    return bulkTriageBatchResponseSchema.parse(toBatchResponse(row));
  });

  app.post("/bulk-triage/undo", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = bulkTriageUndoRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const userId = requireUser(request).id;

    const [row] = await db
      .select()
      .from(bulkTriageBatches)
      .where(
        and(eq(bulkTriageBatches.id, parsed.data.batchId), eq(bulkTriageBatches.userId, userId)),
      )
      .limit(1);
    if (!row) {
      return bulkTriageUndoResponseSchema.parse({ status: "not_found", affectedCount: 0 });
    }
    // A retried undo of a batch already undone replays the same answer
    // rather than reversing it a second time — the same idempotent-replay
    // posture `sync/mutations.ts` gives every mutation outcome.
    if (row.undoneAt) {
      return bulkTriageUndoResponseSchema.parse({
        status: "undone",
        affectedCount: row.affectedThreadIds.length,
      });
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      return bulkTriageUndoResponseSchema.parse({ status: "expired", affectedCount: 0 });
    }

    await undoBulkTriageAction(db, row.action, row.affectedThreadIds);
    await db
      .update(bulkTriageBatches)
      .set({ undoneAt: new Date() })
      .where(eq(bulkTriageBatches.id, row.id));

    return bulkTriageUndoResponseSchema.parse({
      status: "undone",
      affectedCount: row.affectedThreadIds.length,
    });
  });
}

/**
 * `until` is a ceiling the Client can only lower, never raise past "now" —
 * the mechanism behind "a Thread arriving after the request is not touched"
 * for a *bounded* group (every date-group header but "Today" — #67's
 * acceptance bar). A future-dated `until` is silently clamped to `now`,
 * never rejected: a stale or generous value reaching past the request's own
 * instant is the mistake this guards against, not a reason to fail the
 * whole request.
 *
 * `null` is different in kind, not just in value: it is not a value to
 * clamp at all, but the Client saying "no ceiling" — the open-ended "Today"
 * group's own shape (`group-target.ts#groupDateRange`'s own doc comment:
 * "so a Thread arriving after the request still lands in it"). Substituting
 * `now` for it used to collapse that distinction into the same "up to this
 * instant" ceiling every bounded group already gets, which is exactly what
 * let a Thread whose `lastMessageAt` landed in the gap between the User's
 * click and this handler's own execution — the newest row in "Today" is the
 * one most likely to — sit right at that seam: optimistically collapsed
 * client-side (`group-target.ts`'s own boundary math has no upper bound for
 * "Today" either) while silently missing this handler's target set. Passed
 * straight through to `selectTargetThreadIds`, which already treats `null`
 * as "no upper bound" the same way it already does for `since`.
 */
function clampUntil(until: string | null, now: Date): Date | null {
  if (until === null) return null;
  const requested = new Date(until);
  return requested < now ? requested : now;
}

async function batchRow(db: Db, id: string): Promise<typeof bulkTriageBatches.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(bulkTriageBatches)
    .where(eq(bulkTriageBatches.id, id))
    .limit(1);
  return row ?? null;
}

interface NewBatch {
  id: string;
  userId: string;
  action: "done" | "markRead";
  affectedThreadIds: string[];
  accounts: BulkTriageAccountOutcomeRow[];
  createdAt: Date;
}

/**
 * Inserts the batch's ledger row, racing the same way
 * `sync/mutations.ts#applyOne` does: a concurrent resend of the same `id`
 * (a retried request, the ordinary shape of a dropped response) can lose the
 * insert to a parallel copy of this same handler — the unique `id` primary
 * key is the real correctness barrier, and losing the race here is harmless
 * because both copies computed the same outcome from the same target set.
 */
async function insertBatchRow(
  db: Db,
  batch: NewBatch,
): Promise<typeof bulkTriageBatches.$inferSelect> {
  const expiresAt = new Date(batch.createdAt.getTime() + BULK_TRIAGE_UNDO_WINDOW_SECONDS * 1000);
  try {
    const [row] = await db
      .insert(bulkTriageBatches)
      .values({
        id: batch.id,
        userId: batch.userId,
        action: batch.action,
        affectedThreadIds: batch.affectedThreadIds,
        accounts: batch.accounts,
        expiresAt,
      })
      .returning();
    if (!row) throw new Error("bulk-triage batch insert returned no row");
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await batchRow(db, batch.id);
      if (existing) return existing;
    }
    throw error;
  }
}

function toBatchResponse(row: typeof bulkTriageBatches.$inferSelect) {
  return {
    batchId: row.id,
    affectedCount: row.affectedThreadIds.length,
    accounts: row.accounts,
  };
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
