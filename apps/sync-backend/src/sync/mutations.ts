import type {
  GatekeeperSender,
  MutationIntent,
  MutationOutcome,
  QueuedMutation,
  QueuedUserMutation,
  UserMutationIntent,
} from "@mail/shared";
import {
  DEFAULT_UNDO_SEND_DELAY_SECONDS,
  isValidLabelName,
  labelId,
  normalizeLabelName,
  UNDO_SEND_DELAY_OPTIONS,
} from "@mail/shared";
import { and, eq, sql } from "drizzle-orm";
import { acceptSend, cancelSend } from "../compose/pending-send.js";
import type { Db } from "../db/client.js";
import {
  appliedMutations,
  folders,
  labels,
  mailAccounts,
  messages,
  threads,
  users,
} from "../db/schema.js";
import { approveSender, blockSender, denySender, unblockSender } from "../gatekeeper/decisions.js";
import {
  updateMailAccountNotificationsEnabled,
  updateMailAccountSignature,
} from "../mail-accounts/store.js";
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
 * nothing to retry it into. `setPinned`/`applyLabel`/`removeLabel` (#43) are
 * App Features (ADR-0006): all three touch only the Thread row, and none
 * ever enqueues a protocol write — no IMAP-side trace for either feature.
 * `snooze` (#76) is the same shape, plus `archive`/`trash`'s own
 * synchronous `inInbox: false` ack — a permanent rejection for a Thread this
 * account no longer has, same as every intent above, and also for a
 * non-future `until` (`invalid_snooze_time`), since a Thread can't be
 * snoozed into the past.
 */
async function applyIntent(
  db: Db,
  mailAccountId: string,
  intent: MutationIntent,
): Promise<IntentResult> {
  // The two Composition intents (#46) and the two Preference intents (#54)
  // name no Thread, so they are dispatched ahead of the Thread lookup every
  // other intent starts from.
  if (intent.type === "sendComposition" || intent.type === "cancelSend") {
    return applyCompositionIntent(db, mailAccountId, intent);
  }
  if (intent.type === "setSignature") {
    await updateMailAccountSignature(db, mailAccountId, intent.signature);
    return { ok: true };
  }
  if (intent.type === "setNotificationsEnabled") {
    await updateMailAccountNotificationsEnabled(db, mailAccountId, intent.enabled);
    return { ok: true };
  }
  // The Screener's decisions (#55). Like the two above they name no Thread —
  // "one decision per stranger, not per message" (poc-spec.md) — so they are
  // dispatched here, ahead of the Thread lookup, and `gatekeeper/decisions.ts`
  // resolves the sender to whatever Threads they are currently holding.
  if (
    intent.type === "approveSender" ||
    intent.type === "denySender" ||
    intent.type === "blockSender" ||
    intent.type === "unblockSender"
  ) {
    return applyGatekeeperIntent(db, mailAccountId, intent);
  }

  const [thread] = await db
    .select({ id: threads.id, labelIds: threads.labelIds })
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
      await db
        .update(threads)
        // Also clears `snoozeUntil` (#76): archiving/trashing a still-snoozed
        // Thread is a more final decision than the one Snooze made, and
        // without this the wake sweep (`sync/snooze.ts`) would later flip
        // `inInbox` back to `true` on a Thread the User has since archived
        // or trashed — "un-triaging" it out from under them.
        .set({ inInbox: false, folderRole: intent.type, snoozeUntil: null })
        .where(eq(threads.id, intent.threadId));
      await enqueueProtocolWrites(db, mailAccountId, inboxMessageIds, intent.type);
      return { ok: true };
    }

    case "setPinned":
      // Pin (#43) is an App Feature (ADR-0006): the Thread row is the whole
      // of it, and unlike `setStarred`/`setRead` above, no protocol write is
      // ever enqueued — there is nothing on the IMAP side for a Pin to be.
      await db
        .update(threads)
        .set({ pinned: intent.pinned })
        .where(eq(threads.id, intent.threadId));
      return { ok: true };

    case "snooze": {
      // Snooze (#76) is an App Feature exactly like Pin above — the Thread
      // row is the whole of it, no protocol write ever enqueued — but,
      // mirroring `archive`/`trash`'s synchronous-ack shape, it also flips
      // `inInbox` to `false` the instant it lands: a snoozed Thread leaves
      // the Inbox the same round trip that acks the mutation, not once
      // `sync/snooze.ts`'s wake sweep eventually clears it.
      const until = new Date(intent.until);
      if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
        return { ok: false, reason: "invalid_snooze_time" };
      }
      await db
        .update(threads)
        .set({ inInbox: false, snoozeUntil: until })
        .where(eq(threads.id, intent.threadId));
      return { ok: true };
    }

    case "applyLabel": {
      const name = normalizeLabelName(intent.name);
      if (!isValidLabelName(name)) return { ok: false, reason: "invalid_label_name" };
      const id = labelId(mailAccountId, name);

      // Find-or-create by the deterministic id (#43): a Client that already
      // predicted this id offline and one applying the same name for the
      // first time both land here, and `onConflictDoNothing` is what makes
      // two concurrent first-applies of the same brand-new name resolve to
      // one Label row instead of a unique-index error.
      await db.insert(labels).values({ id, mailAccountId, name }).onConflictDoNothing({
        target: labels.id,
      });

      if (!thread.labelIds.includes(id)) {
        await db
          .update(threads)
          .set({ labelIds: sql`array_append(${threads.labelIds}, ${id})` })
          .where(eq(threads.id, intent.threadId));
      }
      return { ok: true };
    }

    case "removeLabel": {
      const id = labelId(mailAccountId, normalizeLabelName(intent.name));
      if (thread.labelIds.includes(id)) {
        await db
          .update(threads)
          .set({ labelIds: thread.labelIds.filter((existing) => existing !== id) })
          .where(eq(threads.id, intent.threadId));
      }
      // A name with no matching applied Label (already removed, or never
      // applied) is a harmless no-op — the same tolerance `archive`/`trash`
      // already have for a Thread already in the requested state.
      return { ok: true };
    }
  }
}

/**
 * The four Gatekeeper intents (#55, poc-spec.md §Gatekeeper v1). Thin
 * dispatch over `gatekeeper/decisions.ts`, which owns what each decision
 * actually does to the held Threads and to the Verdict table.
 *
 * The only rejection any of them can produce is `barred_verdict_domain` — a
 * domain-scoped decision aimed at a public provider (`@mail/shared`'s
 * `BARRED_VERDICT_DOMAINS`). Permanent, correctly: no retry of the same
 * intent will ever make `gmail.com` a sensible thing to approve or block
 * wholesale.
 */
async function applyGatekeeperIntent(
  db: Db,
  mailAccountId: string,
  intent: Extract<MutationIntent, { sender: GatekeeperSender }>,
): Promise<IntentResult> {
  switch (intent.type) {
    case "approveSender":
      return approveSender(db, mailAccountId, intent.sender);
    case "denySender":
      return denySender(db, mailAccountId, intent.sender);
    case "blockSender":
      return blockSender(db, mailAccountId, intent.sender);
    case "unblockSender":
      return unblockSender(db, mailAccountId, intent.sender);
  }
}

/**
 * `sendComposition`/`cancelSend` (#46, ADR-0007). Both are thin wrappers over
 * `compose/pending-send.ts`'s conditional transitions — the whole point of
 * routing them through this queue rather than a dedicated route is that they
 * inherit its idempotency ledger, so a resent `sendComposition` id replays
 * its recorded outcome instead of arming a second Pending Send.
 *
 * The delay is read from the sending User's own preference here, not taken
 * from the intent: ADR-0007 measures it "from server receipt, never from the
 * Client's clock", which makes `submit_after` this server's to compute.
 *
 * A `too_late` cancel is a `rejected` outcome, which is what the Client turns
 * into ADR-0007's "reported to the User as too late" — the one rejection in
 * this whole union that is an ordinary, expected result rather than a bug or
 * a stale Client.
 */
async function applyCompositionIntent(
  db: Db,
  mailAccountId: string,
  intent: Extract<MutationIntent, { compositionId: string }>,
): Promise<IntentResult> {
  if (intent.type === "cancelSend") {
    const result = await cancelSend(db, mailAccountId, intent.compositionId);
    return result.status === "cancelled" ? { ok: true } : { ok: false, reason: result.reason };
  }

  const delaySeconds = await undoSendDelayForAccount(db, mailAccountId);
  const result = await acceptSend(db, mailAccountId, intent.compositionId, delaySeconds);
  return result.status === "accepted" ? { ok: true } : { ok: false, reason: result.reason };
}

/**
 * The owning User's Undo Send delay, clamped to the values the wire contract
 * allows (`@mail/shared`'s `UNDO_SEND_DELAY_OPTIONS`). A row written before
 * the column existed, or an out-of-range value from a future/older build,
 * falls back to the default rather than producing a delay nothing in the UI
 * can describe.
 */
async function undoSendDelayForAccount(db: Db, mailAccountId: string): Promise<number> {
  const [row] = await db
    .select({ delay: users.undoSendDelaySeconds })
    .from(mailAccounts)
    .innerJoin(users, eq(mailAccounts.userId, users.id))
    .where(eq(mailAccounts.id, mailAccountId))
    .limit(1);
  const delay = row?.delay ?? DEFAULT_UNDO_SEND_DELAY_SECONDS;
  return UNDO_SEND_DELAY_OPTIONS.includes(delay as (typeof UNDO_SEND_DELAY_OPTIONS)[number])
    ? delay
    : DEFAULT_UNDO_SEND_DELAY_SECONDS;
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

/**
 * Applies one User's queued Preference edits (#54): the User-scoped half of
 * ADR-0010's Optimistic Action queue, alongside `flushMutations` above for
 * the Mail-Account-scoped half. Same idempotency ledger (`applied_mutations`,
 * keyed by `userId` here instead of `mailAccountId`), same FIFO-in-array-order
 * contract, same "one rejected entry doesn't stop the rest" independence —
 * there is simply no Thread, Composition, or IMAP side-effect a Preference
 * edit could ever have.
 */
export async function flushUserMutations(
  db: Db,
  userId: string,
  queued: QueuedUserMutation[],
): Promise<MutationOutcome[]> {
  const outcomes: MutationOutcome[] = [];
  for (const { id, intent } of queued) {
    outcomes.push(await applyOneUserMutation(db, userId, id, intent));
  }
  return outcomes;
}

async function applyOneUserMutation(
  db: Db,
  userId: string,
  id: string,
  intent: UserMutationIntent,
): Promise<MutationOutcome> {
  const existing = await ledgerRow(db, id);
  if (existing) return toOutcome(id, existing);

  const result = await applyUserIntent(db, userId, intent);
  try {
    await db.insert(appliedMutations).values({
      id,
      userId,
      intentType: intent.type,
      status: result.ok ? "applied" : "rejected",
      reason: result.ok ? null : result.reason,
    });
  } catch (error) {
    // Mirrors `applyOne`'s own race handling above — see its comment.
    if (isUniqueViolation(error)) {
      const row = await ledgerRow(db, id);
      if (row) return toOutcome(id, row);
    }
    throw error;
  }

  return result.ok ? { id, status: "applied" } : { id, status: "rejected", reason: result.reason };
}

/** Each variant is an absolute set on one `Preference` field (`sync.ts#userMutationIntentSchema`'s own doc comment) — nothing here can ever be rejected. */
async function applyUserIntent(
  db: Db,
  userId: string,
  intent: UserMutationIntent,
): Promise<IntentResult> {
  switch (intent.type) {
    case "setAutoAdvance":
      await db
        .update(users)
        .set({
          autoAdvanceEnabled: intent.enabled,
          autoAdvanceDirection: intent.direction,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
      return { ok: true };
    case "setUndoSendDelay":
      await db
        .update(users)
        .set({ undoSendDelaySeconds: intent.undoSendDelaySeconds, updatedAt: new Date() })
        .where(eq(users.id, userId));
      return { ok: true };
  }
}

/** Also `routes/bulk-triage.ts`'s own ledger-insert race handling (#67) — same shape, same reason. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}
