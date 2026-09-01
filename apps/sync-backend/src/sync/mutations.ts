import type { MutationIntent, MutationOutcome, QueuedMutation } from "@mail/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appliedMutations, messages, threads } from "../db/schema.js";
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
    // Both `setStarred`/`setRead` are absolute SETs, so having just applied
    // the value again ahead of losing this insert is harmless.
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
 * Both intents act on **every Message in the Thread** — the same
 * granularity `thread-rollup.ts` aggregates over, so the rollup it triggers
 * lands exactly the state the Client's optimistic overlay already predicted
 * (`store/reads.ts`). A Thread the Mail Account no longer has (evicted,
 * merged away, or never this account's to begin with) is a permanent
 * rejection — there is nothing to retry it into.
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
      break;
    case "setRead":
      await db.update(messages).set({ seen: intent.read }).where(threadIs(intent.threadId));
      break;
  }
  await refreshThreadRollups(db, [intent.threadId]);
  return { ok: true };
}

function threadIs(threadId: string) {
  return eq(messages.threadId, threadId);
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
