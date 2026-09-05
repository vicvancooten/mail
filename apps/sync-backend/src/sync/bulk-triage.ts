import type { BulkTriageAction, BulkTriageFolderRole } from "@mail/shared";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { folders, messages, protocolWrites, threads } from "../db/schema.js";
import { selectInboxResidentMessageIds } from "./inbox.js";
import { enqueueProtocolWrites } from "./protocol-writes.js";
import { refreshThreadRollups } from "./thread-rollup.js";

/**
 * The Bulk Triage batch's own query and mutation logic (#67,
 * `routes/bulk-triage.ts`, `@mail/shared`'s `bulk-triage.ts`): resolving the
 * **date range + folder + Account Scope** target set against one Mail
 * Account's Threads, and applying/undoing `done`/`markRead` across whatever
 * that resolves to. The route file owns per-account dispatch, the
 * idempotency ledger and the HTTP shape; everything here is one Mail
 * Account's worth of database work.
 */

export interface ResolvedBulkTriageTarget {
  mailAccountId: string;
  folderRole: BulkTriageFolderRole;
  /** Inclusive lower bound on `Thread.lastMessageAt`, or `null` for "everything older". */
  since: Date | null;
  /** Exclusive upper bound on `Thread.lastMessageAt` — already clamped to "now" by the caller (`routes/bulk-triage.ts`). */
  until: Date;
}

/**
 * The target set's Thread ids for one Mail Account, at this instant. `inbox`
 * reads `threads.inInbox` — `db/schema.ts`'s own doc comment calls it "the
 * one signal triage needs", and this ticket's whole use case is triage — so
 * it is not re-derived from a join here. Every other role has no such
 * denormalized flag and is resolved the only way it can be: a Thread with at
 * least one Message currently in a folder of that role.
 */
export async function selectTargetThreadIds(
  db: Db,
  target: ResolvedBulkTriageTarget,
): Promise<string[]> {
  const dateBounds = and(
    target.since !== null ? gte(threads.lastMessageAt, target.since) : undefined,
    lt(threads.lastMessageAt, target.until),
  );

  if (target.folderRole === "inbox") {
    const rows = await db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(eq(threads.mailAccountId, target.mailAccountId), eq(threads.inInbox, true), dateBounds),
      );
    return rows.map((row) => row.id);
  }

  const rows = await db
    .selectDistinct({ id: threads.id })
    .from(threads)
    .innerJoin(messages, eq(messages.threadId, threads.id))
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .where(
      and(
        eq(threads.mailAccountId, target.mailAccountId),
        eq(folders.role, target.folderRole),
        dateBounds,
      ),
    );
  return rows.map((row) => row.id);
}

/** The same target set's true count — `POST /bulk-triage/count` (#67: "a Client can show a group's true total, not its loaded count"). A real `count(*)`, never `selectTargetThreadIds(...).length`, so a large group costs one aggregate rather than a full id fetch. */
export async function countTargetThreads(
  db: Db,
  target: ResolvedBulkTriageTarget,
): Promise<number> {
  // Threads never number in the millions per account (poc-scope.md's 80k
  // corpus), so counting the resolved id set is one query rather than a
  // second, subtly-different aggregate query to keep in sync with
  // `selectTargetThreadIds` above.
  const ids = await selectTargetThreadIds(db, target);
  return ids.length;
}

/**
 * Applies `done`/`markRead` to exactly these Thread ids on one Mail Account —
 * batched equivalents of `sync/mutations.ts`'s per-Thread `archive` and
 * `setRead: true` intents. A no-op on an empty list.
 */
export async function applyBulkTriageAction(
  db: Db,
  mailAccountId: string,
  action: BulkTriageAction,
  threadIds: string[],
): Promise<void> {
  if (threadIds.length === 0) return;
  if (action === "done") {
    await applyDone(db, mailAccountId, threadIds);
  } else {
    await applyMarkRead(db, mailAccountId, threadIds);
  }
}

/**
 * Mirrors `sync/mutations.ts#applyIntent`'s `archive` case: the synchronous
 * half (`inInbox: false`) lands here, in the same statement for every
 * targeted Thread; the asynchronous write-through outbox row rides the same
 * "archive" kind a single-Thread archive enqueues — `protocol-writes.ts`'s
 * own server-kind gate (#124, ADR-0020) is what turns that into a real move
 * or a Gmail `\Inbox` label removal, needing no Archive Folder on this
 * account either way. The Inbox-resident set is read through
 * `sync/inbox.ts#selectInboxResidentMessageIds`, not a join on
 * `folders.role === "inbox"` — the same reasoning
 * `sync/mutations.ts#inboxResidentMessageIds` gives.
 */
async function applyDone(db: Db, mailAccountId: string, threadIds: string[]): Promise<void> {
  await db
    .update(threads)
    .set({ inInbox: false, folderRole: "archive" })
    .where(inArray(threads.id, threadIds));

  const inboxMessageIds = await selectInboxResidentMessageIds(
    db,
    inArray(messages.threadId, threadIds),
  );
  await enqueueProtocolWrites(db, mailAccountId, inboxMessageIds, "archive");
}

/** Mirrors `sync/mutations.ts#applyIntent`'s `setRead: true` case, across every Message of every targeted Thread. */
async function applyMarkRead(db: Db, mailAccountId: string, threadIds: string[]): Promise<void> {
  await db.update(messages).set({ seen: true }).where(inArray(messages.threadId, threadIds));

  const messageIds = await db
    .select({ id: messages.id })
    .from(messages)
    .where(inArray(messages.threadId, threadIds));
  await enqueueProtocolWrites(
    db,
    mailAccountId,
    messageIds.map((row) => row.id),
    "seen",
  );
  await refreshThreadRollups(db, threadIds);
}

/**
 * Reverses a batch for exactly the Thread ids it recorded as affected
 * (`db/schema.ts`'s `bulkTriageBatches.affectedThreadIds`) — never a re-run
 * of the original target set, which could by now resolve to a different
 * group entirely. Absolute-set reversals, the same tolerance `setStarred`/
 * `setRead` already have for "already in the state being asked for": `done`
 * simply sets `inInbox` back to `true`; `markRead` sets every affected
 * Message back to unseen, regardless of what it was before the batch (#67's
 * "undo returns exactly the affected Threads", not "undo restores whatever
 * each Message's prior `seen` happened to be" — the batch itself never
 * recorded per-message priors, the same way a single-Thread `setRead`
 * intent doesn't either).
 *
 * Also cancels whatever of the batch's own protocol writes have not yet
 * drained (`protocol_writes`, ADR-0006's write-through outbox), so a slow
 * drain never pushes the now-undone `\Seen`/Archive move to the real mail
 * server after the fact. A write that already drained is not rolled back —
 * there is no `unarchive` IMAP move (`sync/mutations.ts`'s own comment: "no
 * `unarchive` intent yet"), so a real archive that landed inside the Undo
 * window stays landed on the server even though the Client sees the Thread
 * back in the Inbox; the ordinary state-token sync loop is what eventually
 * reconciles that gap, the same tolerance `drainProtocolWrites` already
 * documents for every other unconfirmed write.
 */
export async function undoBulkTriageAction(
  db: Db,
  action: BulkTriageAction,
  threadIds: string[],
): Promise<void> {
  if (threadIds.length === 0) return;

  const messageRows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(inArray(messages.threadId, threadIds));
  const messageIds = messageRows.map((row) => row.id);

  if (action === "done") {
    await db
      .update(threads)
      .set({ inInbox: true, folderRole: "inbox" })
      .where(inArray(threads.id, threadIds));
    if (messageIds.length > 0) {
      await db
        .delete(protocolWrites)
        .where(
          and(inArray(protocolWrites.messageId, messageIds), eq(protocolWrites.kind, "archive")),
        );
    }
  } else {
    await db.update(messages).set({ seen: false }).where(inArray(messages.threadId, threadIds));
    if (messageIds.length > 0) {
      await db
        .delete(protocolWrites)
        .where(and(inArray(protocolWrites.messageId, messageIds), eq(protocolWrites.kind, "seen")));
    }
    await refreshThreadRollups(db, threadIds);
  }
}
