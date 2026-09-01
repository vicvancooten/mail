import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { messages, threadMessageIds, threads } from "../db/schema.js";
import { baseSubject } from "./subject.js";
import { recordTombstones } from "./tombstones.js";

/**
 * Thread assembly (#34). Reference-based, order-independent, and merging.
 *
 * The order-independence is the whole point. ADR-0005's backfill runs
 * **newest-first**, so a reply is normally stored before the message it
 * answers, and a naive "attach me to my parent's Thread" rule would put
 * every reply in a Thread of its own. Instead, storing a message registers
 * *every* id in its chain — its own, its `In-Reply-To`, its `References` —
 * against one Thread, so an ancestor arriving later finds the Thread already
 * waiting under its own id.
 *
 * The consequence is that two Threads can turn out to be one: A→B and C→D
 * stay separate until a message arrives referencing both chains. That is a
 * merge, and it is handled rather than avoided — see `mergeThreads`.
 */

export type ThreadRow = typeof threads.$inferSelect;

export interface ResolveThreadInput {
  mailAccountId: string;
  /** The chain, oldest ancestor first, own id last — `threadingIdsFor()`. */
  threadingIds: string[];
  /** Used only to label a brand-new Thread; threading itself ignores subjects. */
  subject: string | null;
  /** Used only to pick which Thread survives a merge. */
  receivedAt: Date;
}

/**
 * Finds or creates the Thread a message belongs to and registers its whole
 * id chain against it. Call inside the same transaction as the message
 * insert — a Thread with no message in it is a row the list would render
 * empty.
 */
export async function resolveThread(db: Db, input: ResolveThreadInput): Promise<string> {
  const ids = input.threadingIds.filter((id) => id.length > 0);

  const linked = ids.length
    ? await db
        .select({ threadId: threadMessageIds.threadId })
        .from(threadMessageIds)
        .where(
          and(
            eq(threadMessageIds.mailAccountId, input.mailAccountId),
            inArray(threadMessageIds.messageIdHeader, ids),
          ),
        )
    : [];

  const candidates = [...new Set(linked.map((row) => row.threadId))];

  let threadId: string;
  if (candidates.length === 0) {
    threadId = await createThread(db, input);
  } else if (candidates.length === 1) {
    threadId = candidates[0] as string;
  } else {
    threadId = await mergeThreads(db, input.mailAccountId, candidates);
  }

  if (ids.length) {
    await db
      .insert(threadMessageIds)
      .values(
        ids.map((messageIdHeader) => ({
          mailAccountId: input.mailAccountId,
          messageIdHeader,
          threadId,
        })),
      )
      // An id already pointing at a *different* Thread cannot happen here:
      // any such Thread was in `candidates` and has just been merged into
      // this one. `DO NOTHING` therefore only ever skips exact repeats.
      .onConflictDoNothing();
  }

  return threadId;
}

async function createThread(db: Db, input: ResolveThreadInput): Promise<string> {
  const id = randomUUID();
  await db.insert(threads).values({
    id,
    mailAccountId: input.mailAccountId,
    subject: baseSubject(input.subject),
    firstMessageAt: input.receivedAt,
    lastMessageAt: input.receivedAt,
  });
  return id;
}

/**
 * Collapses several Threads into one when a late arrival proves they were
 * always the same conversation.
 *
 * The oldest Thread wins — it holds the message the others are ultimately
 * replies to, so keeping its id keeps the identity a Client may already have
 * cached pointing at the right conversation. The losers' messages and id
 * registrations are reassigned and the empty rows deleted; ADR-0011's
 * `destroyed` list (#37, `sync/collection-sync.ts`) is how Clients learn the
 * losing ids are gone.
 */
async function mergeThreads(
  db: Db,
  mailAccountId: string,
  candidateIds: string[],
): Promise<string> {
  const rows = await db
    .select()
    .from(threads)
    .where(and(eq(threads.mailAccountId, mailAccountId), inArray(threads.id, candidateIds)));

  const ordered = [...rows].sort((left, right) => {
    const leftAt = left.firstMessageAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const rightAt = right.firstMessageAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (leftAt !== rightAt) return leftAt - rightAt;
    // Deterministic tie-break so two concurrent merges of the same set pick
    // the same survivor rather than each other's loser.
    return left.id.localeCompare(right.id);
  });

  const survivor = ordered[0];
  if (!survivor) {
    throw new Error(`Thread merge found no rows for ${candidateIds.join(", ")}`);
  }
  const losers = ordered.slice(1).map((row) => row.id);
  if (losers.length === 0) return survivor.id;

  await db
    .update(messages)
    .set({ threadId: survivor.id, updatedAt: new Date() })
    .where(inArray(messages.threadId, losers));
  await db
    .update(threadMessageIds)
    .set({ threadId: survivor.id })
    .where(inArray(threadMessageIds.threadId, losers));
  await db.delete(threads).where(inArray(threads.id, losers));
  await recordTombstones(db, { mailAccountId, collection: "Thread", entityIds: losers });

  return survivor.id;
}

/**
 * Deletes Threads that no longer hold any message — what is left after a
 * folder is re-ingested under a new UIDVALIDITY, or a message is expunged.
 * Their `thread_message_ids` rows cascade away with them, so a Thread that
 * comes back later is genuinely rebuilt rather than resurrected half-empty.
 *
 * Tombstoned individually (ADR-0011's `destroyed` list, #37) even though
 * `sync/ingest.ts#applyUidValidity`'s rebuild case also bumps the account's
 * `threadsEpoch` and so answers with a Thread `reset: true` regardless —
 * belt and braces costs one small table's worth of rows, and every other
 * caller (a message vanishing via `sync/delta.ts`'s UID diff) has no reset
 * to fall back on and needs these to make the destroyed list at all.
 */
export async function deleteEmptyThreads(db: Db, mailAccountId: string): Promise<number> {
  const deleted = await db
    .delete(threads)
    .where(
      and(
        eq(threads.mailAccountId, mailAccountId),
        sql`not exists (select 1 from ${messages} where ${messages.threadId} = ${threads.id})`,
      ),
    )
    .returning({ id: threads.id });
  await recordTombstones(db, {
    mailAccountId,
    collection: "Thread",
    entityIds: deleted.map((row) => row.id),
  });
  return deleted.length;
}
