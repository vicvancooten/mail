import type { MutationIntent, MutationOutcome, QueuedMutation } from "@mail/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appliedMutations, folders, messages, threads } from "../db/schema.js";
import { findFolderByRole } from "./folders.js";
import { enqueueProtocolWrites } from "./protocol-writes.js";
import { refreshThreadRollups } from "./thread-rollup.js";

/**
 * Applies one Mail Account's queued Optimistic Actions (ADR-0010, #39),
 * in the array's order — **that order is the FIFO the Client promised**,
 * never re-derived here. Each mutation is checked against the idempotency
 * ledger (`applied_mutations`) before anything is written: a retried id
 * (the ordinary shape of a dropped response over a flaky connection)
 * replays its recorded outcome rather than re-applying, which is what makes
 * a flush **exactly-once** rather than at-least-once. One rejected
 * mutation does not stop the rest of the array from being attempted —
 * each is independent, and "queue order preserved" is about *processing*
 * order, not an all-or-nothing batch.
 */
export async function flushMutations(
  db: Db,
  mailAccountId: string,
  queued: QueuedMutation[],
): Promise<MutationOutcome[]> {
  const outcomes: MutationOutcome[] = [];
  for (const { id, intent } of queued) {
    outcomes.push(await applyOne(db, mailAccountId, id, intent));
  }
  return outcomes;
}

async function applyOne(
  db: Db,
  mailAccountId: string,
  id: string,
  intent: MutationIntent,
): Promise<MutationOutcome> {
  const existing = await ledgerRow(db, id);
  if (existing) return toOutcome(id, existing);

  const result = await applyIntent(db, mailAccountId, intent);
  try {
    await db.insert(appliedMutations).values({
      id,
      mailAccountId,
      intentType: intent.type,
      status: result.ok ? "applied" : "rejected",
      reason: result.ok ? null : result.reason,
    });
  } catch (error) {
    // A concurrent resend of the same id raced this one to the ledger
    // insert — the unique `id` primary key is the real correctness
    // barrier, this catch just turns that race into the same idempotent
    // reply the pre-check above handles in the ordinary (sequential) case.
    // `setStarred`/`setRead` are absolute SETs and `archive`/`trash` are
    // themselves idempotent (re-flipping `inInbox` to `false`, queuing a
    // handful of redundant but harmless outbox rows `protocol-writes.ts`'s
    // own "already there" check absorbs), so having just applied the intent
    // again ahead of losing this insert is harmless either way.
    if (isUniqueViolation(error)) {
      const row = await ledgerRow(db, id);
      if (row) return toOutcome(id, row);
    }
    throw error;
  }

  return result.ok ? { id, status: "applied" } : { id, status: "rejected", reason: result.reason };
}

type IntentResult = { ok: true } | { ok: false; reason: string };

/**
 * `setStarred`/`setRead` act on **every Message in the Thread** — the same
 * granularity `thread-rollup.ts` aggregates over, so the rollup they trigger
 * lands exactly the state the Client's optimistic overlay already predicted
 * (`store/reads.ts`). `archive`/`trash` act on whatever of the Thread's
 * Messages currently sit in the Inbox — a Sent self-copy elsewhere never
 * moves. A Thread the Mail Account no longer has (evicted, merged away, or
 * never this account's to begin with) is a permanent rejection — there is
 * nothing to retry it into.
 */
async function applyIntent(
  db: Db,
  mailAccountId: string,
  intent: MutationIntent,
): Promise<IntentResult> {
  const [thread] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, intent.threadId), eq(threads.mailAccountId, mailAccountId)))
    .limit(1);
  if (!thread) return { ok: false, reason: "thread_not_found" };

  switch (intent.type) {
    case "setStarred":
      await db.update(messages).set({ flagged: intent.starred }).where(threadIs(intent.threadId));
      await enqueueProtocolWrites(
        db,
        mailAccountId,
        await threadMessageIds(db, intent.threadId),
        "flagged",
      );
      await refreshThreadRollups(db, [intent.threadId]);
      return { ok: true };

    case "setRead":
      await db.update(messages).set({ seen: intent.read }).where(threadIs(intent.threadId));
      await enqueueProtocolWrites(
        db,
        mailAccountId,
        await threadMessageIds(db, intent.threadId),
        "seen",
      );
      await refreshThreadRollups(db, [intent.threadId]);
      return { ok: true };

    case "archive":
    case "trash": {
      // The synchronous half of the Optimistic Action's ack (ADR-0006): the
      // Sync Backend's own store is truth, so the Thread drops out of the
      // Client's one list the moment this lands, in the very same round
      // trip that acks the mutation — not once the real IMAP `MOVE` below
      // eventually completes. Rejected outright, rather than left to always
      // "succeed" with nothing to show for it, when this account simply has
      // no folder to move the message into.
      const target = await findFolderByRole(db, mailAccountId, intent.type);
      if (!target) return { ok: false, reason: `no_${intent.type}_folder` };

      const inboxMessageIds = await inboxResidentMessageIds(db, intent.threadId);
      await db.update(threads).set({ inInbox: false }).where(eq(threads.id, intent.threadId));
      await enqueueProtocolWrites(db, mailAccountId, inboxMessageIds, intent.type);
      return { ok: true };
    }
  }
}

function threadIs(threadId: string) {
  return eq(messages.threadId, threadId);
}

async function threadMessageIds(db: Db, threadId: string): Promise<string[]> {
  const rows = await db.select({ id: messages.id }).from(messages).where(threadIs(threadId));
  return rows.map((row) => row.id);
}

/** The subset of a Thread's Messages `archive`/`trash` actually move — Sent/other-folder copies stay put. */
async function inboxResidentMessageIds(db: Db, threadId: string): Promise<string[]> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(folders, eq(messages.folderId, folders.id))
    .where(and(threadIs(threadId), eq(folders.role, "inbox")));
  return rows.map((row) => row.id);
}

async function ledgerRow(
  db: Db,
  id: string,
): Promise<{ status: "applied" | "rejected"; reason: string | null } | null> {
  const [row] = await db
    .select({ status: appliedMutations.status, reason: appliedMutations.reason })
    .from(appliedMutations)
    .where(eq(appliedMutations.id, id))
    .limit(1);
  return row ?? null;
}

function toOutcome(
  id: string,
  row: { status: "applied" | "rejected"; reason: string | null },
): MutationOutcome {
  return row.reason ? { id, status: row.status, reason: row.reason } : { id, status: row.status };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}
