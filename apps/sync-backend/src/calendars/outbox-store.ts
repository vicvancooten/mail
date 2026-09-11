import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type CalendarOutboxRow, calendarOutbox, series } from "../db/schema.js";

/**
 * The write-back outbox's state machine (#237, ADR-0025), `compose/pending-
 * send.ts`'s own shape: every transition is a conditional `UPDATE ... WHERE`
 * rather than a read-then-write, so two ticks (or two processes) claiming
 * the same row can never both win.
 */

/** Transient-failure backoff — the same doubling shape `compose/pending-send.ts` gives a Pending Send, independent constants (a Calendar API failure and an SMTP failure have no reason to share a clock). */
export const OUTBOX_RETRY_BASE_MS = 30_000;
export const OUTBOX_RETRY_CAP_MS = 15 * 60_000;

/** ADR-0025's own bound: "transient failures retry with backoff to a 24-hour deadline and then reject". */
export const OUTBOX_DEADLINE_MS = 24 * 60 * 60_000;

export function outboxRetryDelayMs(attempts: number): number {
  return Math.min(OUTBOX_RETRY_CAP_MS, OUTBOX_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export type CalendarOutboxOperation = CalendarOutboxRow["operation"];

/**
 * Queues (or replaces) the one outstanding push for a Series — `series-store
 * .ts`'s structural mutations and `sync/series-save-store.ts`'s body saves
 * are this function's only callers, always right after applying the same
 * edit locally (ADR-0025: "edits are optimistic and store-first; the
 * upstream write rides an outbox, never the mutation flush").
 *
 * `onConflictDoUpdate` on `series_id` is the coalescing rule (this table's
 * own doc comment): a second edit before the first push lands simply
 * replaces what's queued — fresh `attempts`/`deadline`, the new `operation`
 * and `sendInvitations`, and a freshly re-read `baseEtag` — rather than
 * queuing a second row. Nothing here inspects what a *different* User's
 * Series might have queued: `seriesId` is already scoped to one row, whose
 * `userId` its owning `series` row already enforces.
 */
export async function enqueueOutboxWrite(
  db: Db,
  params: {
    userId: string;
    calendarId: string;
    seriesId: string;
    operation: CalendarOutboxOperation;
    sendInvitations: boolean;
    /** `operation: "move"` only (#238) — the Series this push cancels upstream alongside inserting `seriesId`'s own. */
    moveFromSeriesId?: string | null;
    /** `operation: "respond"` only (#240) — see `calendar_outbox.response_status`'s own doc comment. */
    responseStatus?: CalendarOutboxRow["responseStatus"] | null;
  },
  now: Date = new Date(),
): Promise<void> {
  const [seriesRow] = await db
    .select({ etag: series.etag })
    .from(series)
    .where(eq(series.id, params.seriesId));
  const baseEtag = seriesRow?.etag ?? null;

  const refreshed = {
    userId: params.userId,
    calendarId: params.calendarId,
    operation: params.operation,
    sendInvitations: params.sendInvitations,
    moveFromSeriesId: params.moveFromSeriesId ?? null,
    responseStatus: params.responseStatus ?? null,
    baseEtag,
    attempts: 0,
    nextAttemptAt: null,
    deadline: new Date(now.getTime() + OUTBOX_DEADLINE_MS),
    lastError: null,
    updatedAt: now,
  };

  await db
    .insert(calendarOutbox)
    .values({ id: randomUUID(), seriesId: params.seriesId, ...refreshed })
    .onConflictDoUpdate({
      target: calendarOutbox.seriesId,
      set: refreshed,
    });
}

/** Every due row's id — `nextAttemptAt` unset or already past. A row with no access token available right now is simply skipped by the loop after this (`outbox-loop.ts`), never filtered out here — the same "return the candidates, decide per-row at claim time" split `pending-send.ts#dueSendCandidateIds` draws. */
export async function dueOutboxCandidateIds(db: Db, now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({ id: calendarOutbox.id })
    .from(calendarOutbox)
    .where(isDue(now))
    .orderBy(calendarOutbox.createdAt);
  return rows.map((row) => row.id);
}

function isDue(now: Date) {
  return or(isNull(calendarOutbox.nextAttemptAt), lte(calendarOutbox.nextAttemptAt, now));
}

/** The atomic claim: bumps `attempts` and clears `nextAttemptAt` in the same `UPDATE` that takes it, `pending-send.ts#claimSend`'s own shape. `null` means the claim was lost — already processed, or not due any more. */
export async function claimOutboxEntry(
  db: Db,
  id: string,
  now: Date = new Date(),
): Promise<CalendarOutboxRow | null> {
  const [row] = await db
    .update(calendarOutbox)
    .set({
      attempts: sql`${calendarOutbox.attempts} + 1`,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(and(eq(calendarOutbox.id, id), isDue(now)))
    .returning();
  return row ?? null;
}

/** Deletes a row once it's done — success, a permanent rejection (Rollback already written), or a Series that no longer exists. */
export async function deleteOutboxEntry(db: Db, id: string): Promise<void> {
  await db.delete(calendarOutbox).where(eq(calendarOutbox.id, id));
}

/**
 * A transient failure: bumps `nextAttemptAt` by the backoff, unless
 * `deadline` has already passed, in which case the caller treats this as a
 * permanent rejection instead (ADR-0025: "transient failures retry with
 * backoff to a 24-hour deadline and then reject").
 */
export async function scheduleOutboxRetry(
  db: Db,
  row: CalendarOutboxRow,
  detail: string,
  now: Date = new Date(),
): Promise<{ expired: boolean }> {
  if (now.getTime() >= row.deadline.getTime()) return { expired: true };
  await db
    .update(calendarOutbox)
    .set({
      nextAttemptAt: new Date(now.getTime() + outboxRetryDelayMs(row.attempts)),
      lastError: detail,
      updatedAt: now,
    })
    .where(eq(calendarOutbox.id, row.id));
  return { expired: false };
}

/**
 * A live Needs-Reauth response reached mid-flight (rather than caught by the
 * credential provider returning `null` before this row was ever claimed):
 * rolls the just-taken attempt back so the 24-hour deadline isn't burned
 * while the Facet is parked, `pending-send.ts#releaseForReauth`'s own
 * reasoning.
 */
export async function releaseOutboxForReauth(
  db: Db,
  row: CalendarOutboxRow,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(calendarOutbox)
    .set({ attempts: Math.max(0, row.attempts - 1), nextAttemptAt: null, updatedAt: now })
    .where(eq(calendarOutbox.id, row.id));
}
