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
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { discardComposition, undiscardComposition } from "../compose/discard.js";
import { acceptSend, cancelSend } from "../compose/pending-send.js";
import type { Db } from "../db/client.js";
import { appliedMutations, labels, mailAccounts, messages, threads, users } from "../db/schema.js";
import {
  approveSender,
  blockSender,
  denySender,
  spamSender,
  unblockAndRestore,
  unblockSender,
} from "../gatekeeper/decisions.js";
import { isGmailAccount, type MailAccountServerKind } from "../mail-accounts/server-kind.js";
import {
  getMailAccountServerKind,
  updateMailAccountNotificationsEnabled,
  updateMailAccountSignature,
} from "../mail-accounts/store.js";
import { findFolderByRole } from "./folders.js";
import { selectInboxResidentMessageIds } from "./inbox.js";
import { enqueueProtocolWrites } from "./protocol-writes.js";
import { restoreThreadsToInbox } from "./restore-to-inbox.js";
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
  // Resolved once per flush, not per intent (`sync/thread-rollup.ts`'s own
  // "resolve the account once" shape) — `archive`/`trash`/`restoreToInbox`
  // are the only intents that read it (#124, ADR-0020).
  const serverKind = await getMailAccountServerKind(db, mailAccountId);
  const outcomes: MutationOutcome[] = [];
  for (const { id, intent } of queued) {
    outcomes.push(await applyOne(db, mailAccountId, serverKind, id, intent));
  }
  return outcomes;
}

async function applyOne(
  db: Db,
  mailAccountId: string,
  serverKind: MailAccountServerKind,
  id: string,
  intent: MutationIntent,
): Promise<MutationOutcome> {
  const existing = await ledgerRow(db, id);
  if (existing) return toOutcome(id, existing);

  const result = await applyIntent(db, mailAccountId, serverKind, intent);
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
 * snoozed into the past. `restoreToInbox`/`unsnooze` (#95, ADR-0019) are
 * their real inverses — Undo's own intents, applied through this exact same
 * Thread lookup and rejection, never a queue cancellation.
 *
 * On Gmail (#124, ADR-0020), `archive` no longer needs an Archive-role
 * Folder to reject against — Done there is a `\Inbox` label removal on the
 * All Mail UID, never a move, so `no_archive_folder` is a generic-account
 * rejection only. `trash` is unchanged on every server: Gmail still syncs a
 * real Trash Folder (`sync/sync-plan.ts#GMAIL_SYNCED_ROLES`), and Trash stays
 * a real move there too.
 */
async function applyIntent(
  db: Db,
  mailAccountId: string,
  serverKind: MailAccountServerKind,
  intent: MutationIntent,
): Promise<IntentResult> {
  // The four Composition intents (#46, #101) and the two Preference intents
  // (#54) name no Thread, so they are dispatched ahead of the Thread lookup
  // every other intent starts from.
  if (
    intent.type === "sendComposition" ||
    intent.type === "cancelSend" ||
    intent.type === "discardComposition" ||
    intent.type === "undiscardComposition"
  ) {
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
    intent.type === "spamSender" ||
    intent.type === "unblockSender" ||
    intent.type === "unblockAndRestore"
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
      // trip that acks the mutation — not once the real IMAP write below
      // eventually completes. Rejected outright, rather than left to always
      // "succeed" with nothing to show for it, when this account simply has
      // no folder to move the message into — except a Gmail `archive`
      // (#124, ADR-0020), which needs no such Folder: Done there removes the
      // `\Inbox` label instead of moving anything, so there is nothing to
      // reject against.
      const needsTargetFolder = !(intent.type === "archive" && isGmailAccount(serverKind));
      if (needsTargetFolder) {
        const target = await findFolderByRole(db, mailAccountId, intent.type);
        if (!target) return { ok: false, reason: `no_${intent.type}_folder` };
      }

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

    case "restoreToInbox":
      // Undo's own real inverse of `archive`/`trash` (#95, ADR-0019) — the
      // Thread lookup above already confirmed it belongs to this account,
      // so this is a thin call over the shared restore step.
      await restoreThreadsToInbox(db, mailAccountId, [intent.threadId]);
      return { ok: true };

    case "unsnooze":
      // Undo's own real inverse of `snooze` (#95) — an App Feature exactly
      // like `snooze` itself, so the Thread row is the whole of it, no
      // protocol write. Guarded on `snoozeUntil` actually being set: a
      // Thread that was never snoozed (Undo racing the wake sweep, say) is
      // a harmless no-op, same tolerance `removeLabel` gives a name that
      // was never applied — but without this guard it was not a no-op at
      // all, it unconditionally forced `inInbox: true`, which would
      // un-triage a Thread the User had since archived or trashed out from
      // under that later, more deliberate decision (#90's review). Whoever
      // fires `unsnooze` for a Thread no longer snoozed gets exactly
      // nothing changed, the same as this comment always claimed.
      await db
        .update(threads)
        .set({ inInbox: true, snoozeUntil: null })
        .where(and(eq(threads.id, intent.threadId), isNotNull(threads.snoozeUntil)));
      return { ok: true };

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
 * The Gatekeeper intents (#55, #102, poc-spec.md §Gatekeeper v1, plus #95's
 * `unblockAndRestore`). Thin dispatch over `gatekeeper/decisions.ts`, which
 * owns what each decision actually does to the held Threads and to the
 * Verdict table.
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
    case "spamSender":
      return spamSender(db, mailAccountId, intent.sender);
    case "unblockSender":
      return unblockSender(db, mailAccountId, intent.sender);
    case "unblockAndRestore":
      return unblockAndRestore(db, mailAccountId, intent.sender, intent.threadIds);
  }
}

/**
 * The four Composition intents (#46, #101, ADR-0007, ADR-0012). Each is a
 * thin wrapper over a conditional transition in `compose/pending-send.ts` or
 * `compose/discard.ts` — the whole point of routing them through this queue
 * rather than a dedicated route is that they inherit its idempotency ledger,
 * so a resent id replays its recorded outcome instead of applying twice.
 *
 * `sendComposition`'s delay is read from the sending User's own preference
 * here, not taken from the intent: ADR-0007 measures it "from server
 * receipt, never from the Client's clock", which makes `submit_after` this
 * server's to compute.
 *
 * A `too_late` cancel is a `rejected` outcome, which is what the Client turns
 * into ADR-0007's "reported to the User as too late" — the one rejection in
 * this whole union that is an ordinary, expected result rather than a bug or
 * a stale Client. `discardComposition`/`undiscardComposition` (#101) are the
 * synchronous half of Delete and its Undo — see `compose/discard.ts` for why
 * the IMAP expunge itself is deliberately not here.
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
  if (intent.type === "discardComposition") {
    const result = await discardComposition(db, mailAccountId, intent.compositionId);
    return result.status === "discarded" ? { ok: true } : { ok: false, reason: result.reason };
  }
  if (intent.type === "undiscardComposition") {
    const result = await undiscardComposition(db, mailAccountId, intent.compositionId);
    return result.status === "undiscarded" ? { ok: true } : { ok: false, reason: result.reason };
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

/**
 * The subset of a Thread's Messages `archive`/`trash` actually act on —
 * Sent/other-folder copies stay put. Read through
 * `sync/inbox.ts#selectInboxResidentMessageIds` (#124, ADR-0020) rather than
 * a join on `folders.role === "inbox"`: on a generic account that's the same
 * set either way, but on Gmail the Inbox is a Label on the one All Mail
 * copy, never a Folder of its own.
 */
async function inboxResidentMessageIds(db: Db, threadId: string): Promise<string[]> {
  return selectInboxResidentMessageIds(db, threadIs(threadId));
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
