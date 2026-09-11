import type {
  GatekeeperSender,
  MutationIntent,
  MutationOutcome,
  QueuedMutation,
  QueuedUserMutation,
  TaskSection,
  UserMutationIntent,
} from "@mail/shared";
import {
  CARDDAV_CONTACT_CAPABILITY_TABLE,
  DEFAULT_UNDO_SEND_DELAY_SECONDS,
  EMPTY_NOTE_DOCUMENT,
  GOOGLE_CONTACT_CAPABILITY_TABLE,
  getContactCapabilityTable,
  isValidLabelName,
  LOCAL_CONTACT_CAPABILITY_TABLE,
  labelId,
  MICROSOFT_CONTACT_CAPABILITY_TABLE,
  normalizeLabelName,
  UNDO_SEND_DELAY_OPTIONS,
  validateContactFields,
} from "@mail/shared";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  addressBookCapabilityTableId,
  addressBookRowForUser,
  setDefaultAddressBook,
} from "../address-books/store.js";
import {
  rebuildReminderDueForCalendar,
  rebuildReminderDueForUser,
  snoozeReminderDue,
} from "../calendars/reminder-due-store.js";
import {
  addExdate,
  createSeriesSkeleton,
  deleteSeriesPermanently,
  moveSeries,
  removeExdate,
  restoreSeries,
  trashSeries,
} from "../calendars/series-store.js";
import { discardComposition, undiscardComposition } from "../compose/discard.js";
import { acceptSend, cancelSend } from "../compose/pending-send.js";
import {
  linkContacts,
  pruneContactLinkMembers,
  setContactLinkFront,
  unlinkContact,
} from "../contacts/link-store.js";
import { mergeContacts } from "../contacts/merge-store.js";
import {
  appendContactLabelId,
  contactRowForUser,
  deleteContactRow,
  enqueueMicrosoftContactWrite,
  insertContact,
  restoreContactAndLinkedGroup,
  trashContactAndLinkedGroup,
  updateContactBanner,
  updateContactFields,
  updateContactLabelIds,
} from "../contacts/store.js";
import {
  enqueueContactCarddavFieldsWriteBack,
  enqueueContactFieldsWriteBack,
} from "../contacts/write-back-outbox.js";
import type { Db } from "../db/client.js";
import {
  appliedMutations,
  calendars,
  labels,
  mailAccounts,
  messages,
  notes,
  taskLists,
  tasks,
  threads,
  users,
} from "../db/schema.js";
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
  getMailAccountOwnerId,
  getMailAccountServerKind,
  updateMailAccountNotificationsEnabled,
  updateMailAccountRemoteImages,
  updateMailAccountSignature,
} from "../mail-accounts/store.js";
import { findFolderByRole } from "./folders.js";
import { selectInboxResidentMessageIds } from "./inbox.js";
import { enqueueProtocolWrites } from "./protocol-writes.js";
import { restoreThreadsToInbox } from "./restore-to-inbox.js";
import { INITIAL_TASK_DOCUMENT } from "./task-store.js";
import { refreshThreadRollups } from "./thread-rollup.js";
import { recordTombstones } from "./tombstones.js";

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
  // A Label is owned by the **User**, not this Mail Account (#186,
  // ADR-0023), but the queue being drained names only the account — so the
  // owner is resolved once per flush too, for `applyLabel`/`removeLabel` to
  // derive their `labelId` from.
  const ownerUserId = await getMailAccountOwnerId(db, mailAccountId);
  const outcomes: MutationOutcome[] = [];
  for (const { id, intent } of queued) {
    outcomes.push(await applyOne(db, mailAccountId, ownerUserId, serverKind, id, intent));
  }
  return outcomes;
}

async function applyOne(
  db: Db,
  mailAccountId: string,
  ownerUserId: string | null,
  serverKind: MailAccountServerKind,
  id: string,
  intent: MutationIntent,
): Promise<MutationOutcome> {
  const existing = await ledgerRow(db, id);
  if (existing) return toOutcome(id, existing);

  const result = await applyIntent(db, mailAccountId, ownerUserId, serverKind, intent);
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
 * nothing to retry it into. `setPinned`/`applyLabel`/`removeLabel` (#43;
 * Labels User-scoped since #186 — see `ownerUserId`) are
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
  /** The Mail Account's owning User (#186) — `null` only for an account row that vanished mid-flush, which the two Label intents reject on. */
  ownerUserId: string | null,
  serverKind: MailAccountServerKind,
  intent: MutationIntent,
): Promise<IntentResult> {
  // The four Composition intents (#46, #101) and the three Preference intents
  // (#54, #146) name no Thread, so they are dispatched ahead of the Thread
  // lookup every other intent starts from.
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
  if (intent.type === "setRemoteImages") {
    await updateMailAccountRemoteImages(db, mailAccountId, intent.value);
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
      if (!ownerUserId) return { ok: false, reason: "mail_account_not_found" };
      // User-scoped (#186): the same name applied from any of this User's
      // Mail Accounts resolves to the one Label row, so the id is derived
      // from the owner rather than the account the intent arrived through.
      const id = labelId(ownerUserId, name);

      // Find-or-create by the deterministic id (#43): a Client that already
      // predicted this id offline and one applying the same name for the
      // first time both land here, and `onConflictDoNothing` is what makes
      // two concurrent first-applies of the same brand-new name resolve to
      // one Label row instead of a unique-index error.
      await db.insert(labels).values({ id, userId: ownerUserId, name }).onConflictDoNothing({
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
      if (!ownerUserId) return { ok: false, reason: "mail_account_not_found" };
      const id = labelId(ownerUserId, normalizeLabelName(intent.name));
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
 * Verdict table. `intent.threadId` (#144, on `approveSender`/`blockSender`/
 * `spamSender` only) rides straight through — it is what lets these three
 * also act on an Inbox Thread's own row menu, Reader More menu, or `!` for
 * Spam, not only the Screener's held senders.
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
      return approveSender(db, mailAccountId, intent.sender, intent.threadId);
    case "denySender":
      return denySender(db, mailAccountId, intent.sender);
    case "blockSender":
      return blockSender(db, mailAccountId, intent.sender, intent.threadId);
    case "spamSender":
      return spamSender(db, mailAccountId, intent.sender, intent.threadId);
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

/**
 * The Preference variants are each an absolute set on one field
 * (`sync.ts#userMutationIntentSchema`'s own doc comment) — none of them can
 * ever be rejected. The Note structural variants (#192, ADR-0023) below
 * *can* be — `note_not_found` for `labelNote`/`unlabelNote`/`deleteNote`
 * against a Note this User does not (or no longer) have — but that is the
 * intent queue's own ordinary idempotency-ledger rejection shape, not the
 * `documentSaves` channel's "never rejects" (`note-store.ts`'s own doc
 * comment): the two are about different things wholesale.
 */
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
    case "setHomeTimeZone":
      await db
        .update(users)
        .set({ homeTimeZone: intent.homeTimeZone, updatedAt: new Date() })
        .where(eq(users.id, userId));
      // "Changing the Home Time Zone recomputes every all-day and floating
      // `dueAt`" (ADR-0028) — every Calendar's own Reminders in one sweep,
      // the same posture the Reminder toggle/Default changes below take.
      await rebuildReminderDueForUser(db, userId);
      return { ok: true };
    case "setAnswerNotificationsEnabled":
      await db
        .update(users)
        .set({ answerNotificationsEnabled: intent.enabled, updatedAt: new Date() })
        .where(eq(users.id, userId));
      return { ok: true };
    case "setContactsSortOrder":
      await db
        .update(users)
        .set({ contactsSortOrder: intent.contactsSortOrder, updatedAt: new Date() })
        .where(eq(users.id, userId));
      return { ok: true };
    case "setDefaultAddressBook": {
      const applied = await setDefaultAddressBook(db, userId, intent.addressBookId);
      return applied ? { ok: true } : { ok: false, reason: "address_book_not_found" };
    }
    case "createNote":
      // `onConflictDoNothing` (#43's `applyLabel` uses the same trick): a
      // retried id after a dropped response, and a `noteSaves` row that
      // raced this same id into existence first (`note-store.ts`'s own
      // "created lazily" doc comment) both land here safely — either way
      // the row simply already exists with this User as its owner.
      await db
        .insert(notes)
        .values({ id: intent.noteId, userId, document: EMPTY_NOTE_DOCUMENT, labelIds: [] })
        .onConflictDoNothing({ target: notes.id });
      return { ok: true };
    case "deleteNote": {
      const deleted = await db
        .delete(notes)
        .where(and(eq(notes.id, intent.noteId), eq(notes.userId, userId)))
        .returning({ id: notes.id });
      // A Note already gone (Undo racing a second delete, or a retried id)
      // is a harmless no-op, the same tolerance `removeLabel` gives a name
      // that was never applied — no tombstone for a delete that deleted
      // nothing, since nothing left the collection just now.
      if (deleted.length > 0) {
        await recordTombstones(db, {
          mailAccountId: null,
          collection: "Note",
          entityIds: [intent.noteId],
        });
      }
      return { ok: true };
    }
    case "labelNote": {
      const name = normalizeLabelName(intent.name);
      if (!isValidLabelName(name)) return { ok: false, reason: "invalid_label_name" };
      const note = await noteRow(db, userId, intent.noteId);
      if (!note) return { ok: false, reason: "note_not_found" };

      // User-scoped (#186): the same `labelId` derivation `applyLabel`
      // already uses for a Thread — one set of Labels per User, so a Note
      // and a Thread of this same User's own can share a row.
      const id = labelId(userId, name);
      await db.insert(labels).values({ id, userId, name }).onConflictDoNothing({
        target: labels.id,
      });

      if (!note.labelIds.includes(id)) {
        await db
          .update(notes)
          .set({ labelIds: sql`array_append(${notes.labelIds}, ${id})`, updatedAt: new Date() })
          .where(eq(notes.id, intent.noteId));
      }
      return { ok: true };
    }
    case "unlabelNote": {
      const note = await noteRow(db, userId, intent.noteId);
      if (!note) return { ok: false, reason: "note_not_found" };

      const id = labelId(userId, normalizeLabelName(intent.name));
      if (note.labelIds.includes(id)) {
        await db
          .update(notes)
          .set({
            labelIds: note.labelIds.filter((existing) => existing !== id),
            updatedAt: new Date(),
          })
          .where(eq(notes.id, intent.noteId));
      }
      // A name with no matching applied Label is a harmless no-op — the
      // same tolerance `removeLabel` already gives a Thread.
      return { ok: true };
    }
    // `pinNote`/`unpinNote` (#193): the grid's Pinned/Others split, a genuine
    // inverse pair like `createNote`/`deleteNote` above — not the Thread-style
    // `setPinned` absolute set (`sync.ts#userMutationIntentSchema`'s own doc
    // comment on why). Rejects the same `note_not_found` way `labelNote` does
    // against a Note this User does not (or no longer) have.
    case "pinNote": {
      const note = await noteRow(db, userId, intent.noteId);
      if (!note) return { ok: false, reason: "note_not_found" };
      await db
        .update(notes)
        .set({ pinned: true, updatedAt: new Date() })
        .where(eq(notes.id, intent.noteId));
      return { ok: true };
    }
    case "unpinNote": {
      const note = await noteRow(db, userId, intent.noteId);
      if (!note) return { ok: false, reason: "note_not_found" };
      await db
        .update(notes)
        .set({ pinned: false, updatedAt: new Date() })
        .where(eq(notes.id, intent.noteId));
      return { ok: true };
    }
    // `trashNote`/`restoreNote` (#194): Delete and Recently Deleted's own
    // Restore, a genuine inverse pair the same `pinNote`/`unpinNote` shape
    // above — the row is never removed here (`deleteNote` above stays the
    // permanent one), only `deletedAt` flips, which is what keeps a Note's
    // Labels and `pinned` state exact across a delete/restore round trip
    // with nothing here that has to remember or restore them separately.
    case "trashNote": {
      const note = await noteRow(db, userId, intent.noteId);
      if (!note) return { ok: false, reason: "note_not_found" };
      await db
        .update(notes)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(notes.id, intent.noteId));
      return { ok: true };
    }
    case "restoreNote": {
      const note = await noteRow(db, userId, intent.noteId);
      if (!note) return { ok: false, reason: "note_not_found" };
      await db
        .update(notes)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(notes.id, intent.noteId));
      return { ok: true };
    }
    // A Local Contact's structural actions (#210, ADR-0026) —
    // `sync.ts#userMutationIntentSchema`'s own doc comment on this whole
    // group. `createContact` (#225) names its own target `addressBookId`
    // explicitly rather than always resolving to the caller's Local Address
    // Book (#210's original shape) — Import and Copy/Move both need an
    // ordinary create that can land in any Address Book the User owns, so
    // this validates ownership and the target's own capability table first
    // (`getContactCapabilityTable`, the one declaration every Origin's own
    // table — including CardDAV's `CARDDAV_CONTACT_CAPABILITY_TABLE`, #226 —
    // now shares), the same "check the Address Book, not a hardcoded one"
    // posture `updateContact`/`deleteContact` below already take for an
    // *existing* Contact of any Origin. `microsoft` additionally enqueues
    // Graph's own write-through outbox (#227,
    // `contacts/store.ts#enqueueMicrosoftContactWrite`) — its own
    // `drainMicrosoftContactWrites` already creates a brand-new upstream
    // Person when a queued Contact carries no `microsoftId` yet
    // (`contacts/microsoft/contacts-sync.ts`), so a Copy/Import landing in a
    // Graph-mirrored Address Book genuinely reaches Graph. `google` and
    // `caldav_carddav` do **not** get the same enqueue here: neither
    // write-back outbox (`contacts/write-back-outbox.ts`,
    // `contacts/google/write-back-loop.ts`/`contacts/carddav/write-back-loop.ts`)
    // has a "create a new upstream record" call of its own — both only ever
    // patch a Contact that already carries a `googleResourceName`/
    // `carddavHref` — so a Copy/Import into either kind of mirrored Address
    // Book lands in Wicket only for now (harmless:
    // `contacts/store.ts#listGoogleResourceNamesForAddressBook`'s own
    // `isNotNull` filter, and `listCarddavHrefEtagsForAddressBook`'s own,
    // mean a full sync's reconciliation sweep never touches a
    // resourceName-/href-less row) until a future ticket adds either
    // Origin's own create-push the way Graph's already exists.
    //
    // `deleteContact` itself is the **permanent** delete, the real inverse of
    // a still-queued `createContact` — it is never the User's own "Delete"
    // control (`trashContact` below is), so its own Graph delete push
    // (captured `microsoftId`, below) only ever fires from an
    // already-mirrored row racing an undo, never from the ordinary Delete
    // path. There is no Google/CardDAV delete push here to add
    // symmetrically: today nothing pushes a Local `createContact` into
    // either kind of mirrored book upstream (the previous paragraph), so
    // neither kind of Contact ever reaches `deleteContact` at all in
    // practice.
    case "createContact": {
      const book = await addressBookRowForUser(db, userId, intent.addressBookId);
      if (!book) return { ok: false, reason: "address_book_not_found" };
      const table = getContactCapabilityTable(book.capabilityTableId);
      const validation = validateContactFields(intent.fields, table);
      if (!validation.ok) return { ok: false, reason: validation.reason };
      await insertContact(
        db,
        userId,
        book.id,
        intent.contactId,
        intent.fields,
        book.connectedAccountId,
      );
      if (book.capabilityTableId === "microsoft") {
        await enqueueMicrosoftContactWrite(db, {
          addressBookId: book.id,
          contactId: intent.contactId,
          kind: "upsert",
        });
      }
      return { ok: true };
    }
    case "deleteContact": {
      const contact = await contactRowForUser(db, userId, intent.contactId);
      // A Contact already gone (Undo racing a second delete, or a retried
      // id) is a harmless no-op, the same tolerance `deleteNote` gives —
      // no tombstone for a delete that deleted nothing.
      const deleted = await deleteContactRow(db, userId, intent.contactId);
      if (deleted) {
        // A `ContactLink` naming this Contact can't cascade — its members
        // are a `text[]` with no foreign key (#222, `db/schema.ts`) — so
        // the link drops the member here, dissolving outright if that
        // leaves it with fewer than two.
        await pruneContactLinkMembers(db, userId, [intent.contactId]);
        await recordTombstones(db, {
          mailAccountId: null,
          collection: "Contact",
          entityIds: [intent.contactId],
        });
        if (contact?.microsoftId) {
          await enqueueMicrosoftContactWrite(db, {
            addressBookId: contact.addressBookId,
            microsoftId: contact.microsoftId,
            kind: "delete",
          });
        }
      }
      return { ok: true };
    }
    // `trashContact`/`restoreContact` (#224): Delete and Recently Deleted's
    // own Restore, `trashNote`/`restoreNote`'s own shape — only `deletedAt`
    // flips, the row is never removed here (`deleteContact` above stays the
    // permanent one). Both cascade to every record `contactId` is linked
    // with (`contacts/store.ts#trashContactAndLinkedGroup`'s own doc
    // comment) — ADR-0026's "Delete on a linked card deletes every linked
    // record, one Undo restores all", true regardless of which single member
    // the Client's own intent names. `contactRowForUser` is only this case's
    // own ownership/existence check; the cascade re-derives the group and
    // re-checks `userId` itself for every member it touches.
    case "trashContact": {
      const contact = await contactRowForUser(db, userId, intent.contactId);
      if (!contact) return { ok: false, reason: "contact_not_found" };
      await trashContactAndLinkedGroup(db, userId, intent.contactId);
      return { ok: true };
    }
    case "restoreContact": {
      const contact = await contactRowForUser(db, userId, intent.contactId);
      if (!contact) return { ok: false, reason: "contact_not_found" };
      await restoreContactAndLinkedGroup(db, userId, intent.contactId);
      return { ok: true };
    }
    case "updateContact": {
      const contact = await contactRowForUser(db, userId, intent.contactId);
      if (!contact) return { ok: false, reason: "contact_not_found" };
      const capabilityTableId = await addressBookCapabilityTableId(db, contact.addressBookId);
      const table =
        capabilityTableId === "microsoft"
          ? MICROSOFT_CONTACT_CAPABILITY_TABLE
          : capabilityTableId === "google"
            ? GOOGLE_CONTACT_CAPABILITY_TABLE
            : capabilityTableId === "caldav_carddav"
              ? CARDDAV_CONTACT_CAPABILITY_TABLE
              : LOCAL_CONTACT_CAPABILITY_TABLE;
      const validation = validateContactFields(intent.fields, table);
      if (!validation.ok) return { ok: false, reason: validation.reason };
      await updateContactFields(db, intent.contactId, intent.fields);
      // A mirrored Contact's own write-back — applied to the mirror
      // optimistically above, exactly like a Local Contact's edit, and
      // reaches its own Origin's outbox for the actual round trip:
      // `contacts/google/write-back-loop.ts` chains an etag and reverts the
      // mirror ("upstream wins") on a rejected write (#216); Graph's own
      // `contacts/microsoft/contacts-sync.ts#drainMicrosoftContactWrites`
      // compares `changeKey` instead (#227, this switch's own doc comment
      // above for its lost-update caveat); CardDAV's own
      // `contacts/carddav/write-back-loop.ts` chains an etag and reverts the
      // same "upstream wins" way Google's own loop does (#226). Gated on
      // `capabilityTableId` rather than a `googleResourceName`/`microsoftId`/
      // `carddavHref` truthiness check — the one place every Origin agrees
      // on how to tell "this Contact is mirrored from here" apart.
      if (capabilityTableId === "google" && contact.connectedAccountId) {
        await enqueueContactFieldsWriteBack(db, {
          contactId: intent.contactId,
          connectedAccountId: contact.connectedAccountId,
        });
      } else if (capabilityTableId === "microsoft") {
        await enqueueMicrosoftContactWrite(db, {
          addressBookId: contact.addressBookId,
          contactId: intent.contactId,
          kind: "upsert",
        });
      } else if (capabilityTableId === "caldav_carddav" && contact.connectedAccountId) {
        await enqueueContactCarddavFieldsWriteBack(db, {
          contactId: intent.contactId,
          addressBookId: contact.addressBookId,
        });
      }
      return { ok: true };
    }
    case "labelContact": {
      const name = normalizeLabelName(intent.name);
      if (!isValidLabelName(name)) return { ok: false, reason: "invalid_label_name" };
      const contact = await contactRowForUser(db, userId, intent.contactId);
      if (!contact) return { ok: false, reason: "contact_not_found" };

      // User-scoped (#186): the same `labelId` derivation `labelNote`
      // already uses — one set of Labels per User, so a Contact, a Note and
      // a Thread of this same User's own can share a row.
      const id = labelId(userId, name);
      await db.insert(labels).values({ id, userId, name }).onConflictDoNothing({
        target: labels.id,
      });

      if (!contact.labelIds.includes(id)) {
        await appendContactLabelId(db, intent.contactId, id);
      }
      return { ok: true };
    }
    case "unlabelContact": {
      const contact = await contactRowForUser(db, userId, intent.contactId);
      if (!contact) return { ok: false, reason: "contact_not_found" };

      const id = labelId(userId, normalizeLabelName(intent.name));
      if (contact.labelIds.includes(id)) {
        await updateContactLabelIds(
          db,
          intent.contactId,
          contact.labelIds.filter((existing) => existing !== id),
        );
      }
      // A name with no matching applied Label is a harmless no-op — the
      // same tolerance `unlabelNote` already has.
      return { ok: true };
    }
    // Linked Contacts (#222, ADR-0026) — three intents that write
    // `contact_links` and never a Contact row, which is what makes "a
    // User-scoped link, never a change to any record" true of the code
    // rather than only of the doc comment. Every ownership check is the
    // store's own (`contacts/link-store.ts`), which needs both sides in one
    // query anyway.
    case "linkContacts": {
      const result = await linkContacts(db, {
        userId,
        linkId: intent.linkId,
        contactId: intent.contactId,
        otherContactId: intent.otherContactId,
      });
      // Already linked is the shape a replayed intent takes, not a failure
      // the Client should see — the desired state already holds, the same
      // way `labelContact` reports `ok` for a Label already applied.
      if (!result.ok && result.reason === "already_linked") return { ok: true };
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    }
    case "unlinkContact": {
      // A Contact in no link is a harmless no-op (`unlinkContact`'s own doc
      // comment) — never `contact_not_found`, since the Contact itself is
      // not what this intent is about.
      await unlinkContact(db, userId, intent.contactId);
      return { ok: true };
    }
    case "setLinkedContactFront": {
      const applied = await setContactLinkFront(db, userId, intent.linkId, intent.contactId);
      return applied ? { ok: true } : { ok: false, reason: "contact_link_not_found" };
    }
    case "setContactBanner": {
      // Wicket-only, never gated by `LOCAL_CONTACT_CAPABILITY_TABLE`
      // (`@mail/shared#contactBannerSchema`'s own doc comment) — any Contact
      // this User owns, mirrored or Local, same ownership check
      // `labelContact`/`unlabelContact` already make.
      const contact = await contactRowForUser(db, userId, intent.contactId);
      if (!contact) return { ok: false, reason: "contact_not_found" };
      await updateContactBanner(db, intent.contactId, intent.banner);
      return { ok: true };
    }
    // Merge within one Address Book (#223, ADR-0026) — `contacts/merge-store.ts`
    // does the whole of it in one transaction: whole-replace the survivor's
    // fields, permanently delete the loser, exactly `updateContact`/
    // `deleteContact`'s own write paths.
    case "mergeContacts": {
      const result = await mergeContacts(db, {
        userId,
        contactId: intent.contactId,
        otherContactId: intent.otherContactId,
      });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    }
    // Task Lists (#251, ADR-0030) — see `sync.ts#userMutationIntentSchema`'s
    // own doc comment for the shape every one of these below follows.
    case "createTaskList":
      // `onConflictDoNothing`, `createNote`'s own trick: a retried id after
      // a dropped response simply lands on the row it already created.
      await db
        .insert(taskLists)
        .values({ id: intent.taskListId, userId, name: intent.name, sections: [], order: 0 })
        .onConflictDoNothing({ target: taskLists.id });
      return { ok: true };
    case "renameTaskList": {
      const list = await taskListRow(db, userId, intent.taskListId);
      if (!list) return { ok: false, reason: "task_list_not_found" };
      await db
        .update(taskLists)
        .set({ name: intent.name, updatedAt: new Date() })
        .where(eq(taskLists.id, intent.taskListId));
      return { ok: true };
    }
    case "reorderTaskList": {
      const list = await taskListRow(db, userId, intent.taskListId);
      if (!list) return { ok: false, reason: "task_list_not_found" };
      await db
        .update(taskLists)
        .set({ order: intent.order, updatedAt: new Date() })
        .where(eq(taskLists.id, intent.taskListId));
      return { ok: true };
    }
    // The ticket's own "never deletable": rejected outright against the
    // seeded default List (`isDefault`, stamped only by
    // `task-list-store.ts#ensureDefaultTaskList`) — a property of being the
    // User's first List, not a name check, so renaming it away from "Tasks"
    // never opens this back up.
    case "deleteTaskList": {
      const list = await taskListRow(db, userId, intent.taskListId);
      if (!list) return { ok: false, reason: "task_list_not_found" };
      if (list.isDefault) return { ok: false, reason: "default_list" };
      const deletedAt = new Date();
      await db
        .update(taskLists)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(eq(taskLists.id, intent.taskListId));
      if (intent.taskIds.length > 0) {
        await db
          .update(tasks)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(
            and(
              eq(tasks.taskListId, intent.taskListId),
              eq(tasks.userId, userId),
              inArray(tasks.id, intent.taskIds),
            ),
          );
      }
      return { ok: true };
    }
    // The real inverse of `deleteTaskList` (ADR-0019): restores the List
    // **and** exactly the Tasks it cascaded a soft delete onto — `taskIds`
    // is the same Client-captured set `deleteTaskList` itself carried, not
    // re-derived here (a Task independently trashed before the List delete
    // would otherwise get wrongly resurrected).
    case "restoreTaskList": {
      const list = await taskListRow(db, userId, intent.taskListId);
      if (!list) return { ok: false, reason: "task_list_not_found" };
      await db
        .update(taskLists)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(taskLists.id, intent.taskListId));
      if (intent.taskIds.length > 0) {
        await db
          .update(tasks)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(tasks.taskListId, intent.taskListId),
              eq(tasks.userId, userId),
              inArray(tasks.id, intent.taskIds),
            ),
          );
      }
      return { ok: true };
    }

    // Sections (#251) live on the Task List row's own `sections` array —
    // every case below reads it, mutates the array in place, and writes the
    // whole List row back; none of these touch `sync_tombstones`, since a
    // Section is never its own collection.
    case "createSection": {
      const list = await taskListRow(db, userId, intent.taskListId);
      if (!list) return { ok: false, reason: "task_list_not_found" };
      if (list.sections.some((section) => section.id === intent.sectionId)) return { ok: true };
      const sections = [...list.sections, { id: intent.sectionId, name: intent.name }];
      await db
        .update(taskLists)
        .set({ sections, updatedAt: new Date() })
        .where(eq(taskLists.id, intent.taskListId));
      return { ok: true };
    }
    case "renameSection": {
      const list = await taskListRow(db, userId, intent.taskListId);
      if (!list) return { ok: false, reason: "task_list_not_found" };
      const index = list.sections.findIndex((section) => section.id === intent.sectionId);
      if (index === -1) return { ok: false, reason: "section_not_found" };
      const sections = list.sections.slice();
      sections[index] = { id: intent.sectionId, name: intent.name };
      await db
        .update(taskLists)
        .set({ sections, updatedAt: new Date() })
        .where(eq(taskLists.id, intent.taskListId));
      return { ok: true };
    }
    // Replaces the whole order (the Client already holds it, ADR-0019's own
    // doc comment on `sync.ts`) — tolerant of a stale array missing a
    // Section this List has gained since: anything `sectionIds` doesn't
    // name is appended at the end rather than dropped.
    case "reorderSections": {
      const list = await taskListRow(db, userId, intent.taskListId);
      if (!list) return { ok: false, reason: "task_list_not_found" };
      const byId = new Map(list.sections.map((section) => [section.id, section]));
      const reordered = intent.sectionIds.flatMap((id) => {
        const section = byId.get(id);
        return section ? [section] : [];
      });
      const missing = list.sections.filter((section) => !intent.sectionIds.includes(section.id));
      await db
        .update(taskLists)
        .set({ sections: [...reordered, ...missing], updatedAt: new Date() })
        .where(eq(taskLists.id, intent.taskListId));
      return { ok: true };
    }
    // The real inverse is `restoreSection` below — `taskIds` is this
    // User's own Tasks the delete is about to move off the Section, captured
    // by the Client at decision time (`deleteTaskList`'s own doc comment
    // gives the same reasoning), moved here to the List's first remaining
    // Section, or `null` if none is left.
    case "deleteSection": {
      const list = await taskListRow(db, userId, intent.taskListId);
      if (!list) return { ok: false, reason: "task_list_not_found" };
      const index = list.sections.findIndex((section) => section.id === intent.sectionId);
      if (index === -1) return { ok: true }; // Already gone — a retried id, or Undo racing a second delete.
      const sections = list.sections.filter((section) => section.id !== intent.sectionId);
      const fallbackSectionId = sections[0]?.id ?? null;
      await db
        .update(taskLists)
        .set({ sections, updatedAt: new Date() })
        .where(eq(taskLists.id, intent.taskListId));
      if (intent.taskIds.length > 0) {
        await db
          .update(tasks)
          .set({ sectionId: fallbackSectionId, updatedAt: new Date() })
          .where(
            and(
              eq(tasks.taskListId, intent.taskListId),
              eq(tasks.userId, userId),
              inArray(tasks.id, intent.taskIds),
            ),
          );
      }
      return { ok: true };
    }
    case "restoreSection": {
      const list = await taskListRow(db, userId, intent.taskListId);
      if (!list) return { ok: false, reason: "task_list_not_found" };
      if (list.sections.some((section) => section.id === intent.sectionId)) return { ok: true };
      const sections = list.sections.slice();
      const index = Math.min(Math.max(intent.index, 0), sections.length);
      sections.splice(index, 0, { id: intent.sectionId, name: intent.name });
      await db
        .update(taskLists)
        .set({ sections, updatedAt: new Date() })
        .where(eq(taskLists.id, intent.taskListId));
      if (intent.taskIds.length > 0) {
        await db
          .update(tasks)
          .set({ sectionId: intent.sectionId, updatedAt: new Date() })
          .where(
            and(
              eq(tasks.taskListId, intent.taskListId),
              eq(tasks.userId, userId),
              inArray(tasks.id, intent.taskIds),
            ),
          );
      }
      return { ok: true };
    }

    // Tasks (#251) — `createTask`'s real inverse is the **hard** `deleteTask`
    // below, `createNote`/`deleteNote`'s own pair; `trashTask`/`restoreTask`
    // further down is the separate soft pair, `trashNote`/`restoreNote`'s.
    case "createTask": {
      const list = await taskListRow(db, userId, intent.taskListId);
      if (!list) return { ok: false, reason: "task_list_not_found" };
      await db
        .insert(tasks)
        .values({
          id: intent.taskId,
          userId,
          taskListId: intent.taskListId,
          sectionId: intent.sectionId,
          title: intent.title,
          document: INITIAL_TASK_DOCUMENT,
          order: intent.order,
          labelIds: [],
          threadLink: intent.threadLink ?? null,
        })
        .onConflictDoNothing({ target: tasks.id });
      return { ok: true };
    }
    case "deleteTask": {
      const deleted = await db
        .delete(tasks)
        .where(and(eq(tasks.id, intent.taskId), eq(tasks.userId, userId)))
        .returning({ id: tasks.id });
      // A Task already gone (Undo racing a second delete, or a retried id)
      // is a harmless no-op, `deleteNote`'s own tolerance.
      if (deleted.length > 0) {
        await recordTombstones(db, {
          mailAccountId: null,
          collection: "Task",
          entityIds: [intent.taskId],
        });
      }
      return { ok: true };
    }
    case "setTaskTitle": {
      const task = await taskRow(db, userId, intent.taskId);
      if (!task) return { ok: false, reason: "task_not_found" };
      await db
        .update(tasks)
        .set({ title: intent.title, updatedAt: new Date() })
        .where(eq(tasks.id, intent.taskId));
      return { ok: true };
    }
    case "setTaskDueDate": {
      const task = await taskRow(db, userId, intent.taskId);
      if (!task) return { ok: false, reason: "task_not_found" };
      await db
        .update(tasks)
        .set({
          dueDate: intent.dueDate ? new Date(intent.dueDate) : null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, intent.taskId));
      return { ok: true };
    }
    case "setTaskDueTime": {
      const task = await taskRow(db, userId, intent.taskId);
      if (!task) return { ok: false, reason: "task_not_found" };
      await db
        .update(tasks)
        .set({ dueTime: intent.dueTime, updatedAt: new Date() })
        .where(eq(tasks.id, intent.taskId));
      return { ok: true };
    }
    case "completeTask": {
      const task = await taskRow(db, userId, intent.taskId);
      if (!task) return { ok: false, reason: "task_not_found" };
      const completedAt = new Date();
      await db
        .update(tasks)
        .set({ completed: true, completedAt, updatedAt: completedAt })
        .where(eq(tasks.id, intent.taskId));
      return { ok: true };
    }
    case "uncompleteTask": {
      const task = await taskRow(db, userId, intent.taskId);
      if (!task) return { ok: false, reason: "task_not_found" };
      await db
        .update(tasks)
        .set({ completed: false, completedAt: null, updatedAt: new Date() })
        .where(eq(tasks.id, intent.taskId));
      return { ok: true };
    }
    case "setTaskSection": {
      const task = await taskRow(db, userId, intent.taskId);
      if (!task) return { ok: false, reason: "task_not_found" };
      await db
        .update(tasks)
        .set({ sectionId: intent.sectionId, updatedAt: new Date() })
        .where(eq(tasks.id, intent.taskId));
      return { ok: true };
    }
    case "setTaskList": {
      const task = await taskRow(db, userId, intent.taskId);
      if (!task) return { ok: false, reason: "task_not_found" };
      const list = await taskListRow(db, userId, intent.taskListId);
      if (!list) return { ok: false, reason: "task_list_not_found" };
      await db
        .update(tasks)
        .set({ taskListId: intent.taskListId, sectionId: intent.sectionId, updatedAt: new Date() })
        .where(eq(tasks.id, intent.taskId));
      return { ok: true };
    }
    case "reorderTask": {
      const task = await taskRow(db, userId, intent.taskId);
      if (!task) return { ok: false, reason: "task_not_found" };
      await db
        .update(tasks)
        .set({ order: intent.order, updatedAt: new Date() })
        .where(eq(tasks.id, intent.taskId));
      return { ok: true };
    }
    case "trashTask": {
      const task = await taskRow(db, userId, intent.taskId);
      if (!task) return { ok: false, reason: "task_not_found" };
      await db
        .update(tasks)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(tasks.id, intent.taskId));
      return { ok: true };
    }
    case "restoreTask": {
      const task = await taskRow(db, userId, intent.taskId);
      if (!task) return { ok: false, reason: "task_not_found" };
      await db
        .update(tasks)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(tasks.id, intent.taskId));
      return { ok: true };
    }
    case "labelTask": {
      const name = normalizeLabelName(intent.name);
      if (!isValidLabelName(name)) return { ok: false, reason: "invalid_label_name" };
      const task = await taskRow(db, userId, intent.taskId);
      if (!task) return { ok: false, reason: "task_not_found" };

      // User-scoped (#186), `labelNote`'s own derivation — one set of Labels
      // per User, so a Task can share a row with a Note or a Thread of this
      // same User's own.
      const id = labelId(userId, name);
      await db.insert(labels).values({ id, userId, name }).onConflictDoNothing({
        target: labels.id,
      });

      if (!task.labelIds.includes(id)) {
        await db
          .update(tasks)
          .set({ labelIds: sql`array_append(${tasks.labelIds}, ${id})`, updatedAt: new Date() })
          .where(eq(tasks.id, intent.taskId));
      }
      return { ok: true };
    }
    case "unlabelTask": {
      const task = await taskRow(db, userId, intent.taskId);
      if (!task) return { ok: false, reason: "task_not_found" };

      const id = labelId(userId, normalizeLabelName(intent.name));
      if (task.labelIds.includes(id)) {
        await db
          .update(tasks)
          .set({
            labelIds: task.labelIds.filter((existing) => existing !== id),
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, intent.taskId));
      }
      // A name with no matching applied Label is a harmless no-op — the
      // same tolerance `unlabelNote` already gives a Note.
      return { ok: true };
    }
    // A Series' structural actions (#233) — see `sync.ts#userMutationIntentSchema`'s
    // own doc comment for the shape each pair takes. Every store call below
    // already carries its own idempotency tolerance (a retried id, or Undo
    // racing a later edit, is a harmless no-op), so each is a thin dispatch.
    case "createSeries":
      return createSeriesSkeleton(db, userId, intent.seriesId, intent.calendarId);
    case "deleteSeries":
      await deleteSeriesPermanently(db, userId, intent.seriesId);
      return { ok: true };
    case "trashSeries":
      return trashSeries(db, userId, intent.seriesId);
    case "restoreSeries":
      return restoreSeries(db, userId, intent.seriesId);
    case "addExdate":
      return addExdate(db, userId, intent.seriesId, intent.exdate);
    case "removeExdate":
      return removeExdate(db, userId, intent.seriesId, intent.exdate);
    case "moveSeries":
      return moveSeries(db, userId, intent.seriesId, intent.newSeriesId, intent.calendarId);
    // A Calendar's settings sheet (#236) — see `sync.ts#userMutationIntentSchema`'s
    // own doc comment on why these are four absolute-set intents rather than
    // one combined "patch".
    case "updateCalendarDetails": {
      const calendar = await calendarRow(db, userId, intent.calendarId);
      if (!calendar) return { ok: false, reason: "calendar_not_found" };
      // "A Calendar the upstream grants only reading of shows no edit
      // affordances at all" (#236) — the sheet never sends this intent for
      // one, so this is defense in depth against a stale client, not the
      // primary guard.
      if (!calendar.capabilities.writable) return { ok: false, reason: "calendar_not_writable" };
      await db
        .update(calendars)
        .set({
          name: intent.name,
          description: intent.description,
          timeZone: intent.timeZone,
          updatedAt: new Date(),
        })
        .where(eq(calendars.id, intent.calendarId));
      return { ok: true };
    }
    case "setCalendarColor": {
      const calendar = await calendarRow(db, userId, intent.calendarId);
      if (!calendar) return { ok: false, reason: "calendar_not_found" };
      await db
        .update(calendars)
        .set({ color: intent.color, updatedAt: new Date() })
        .where(eq(calendars.id, intent.calendarId));
      return { ok: true };
    }
    case "setDefaultCalendar": {
      const calendar = await calendarRow(db, userId, intent.calendarId);
      if (!calendar) return { ok: false, reason: "calendar_not_found" };
      if (calendar.isDefault) return { ok: true };
      // "Exactly one `true` row per User" (`calendars.ts#calendarSchema`'s
      // own doc comment) — cleared and set in one transaction so a crash
      // mid-way never leaves either zero or two default Calendars.
      await db.transaction(async (tx) => {
        await tx
          .update(calendars)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(eq(calendars.userId, userId), eq(calendars.isDefault, true)));
        await tx
          .update(calendars)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(calendars.id, intent.calendarId));
      });
      return { ok: true };
    }
    case "setCalendarMailAccount": {
      const calendar = await calendarRow(db, userId, intent.calendarId);
      if (!calendar) return { ok: false, reason: "calendar_not_found" };
      // "Always `null` for a mirrored Calendar, whose Organiser is the
      // upstream's own concern" (`calendars.ts#calendarSchema`'s own doc
      // comment) — settable for Local Calendars only until a self-scheduled
      // Calendar concept exists to extend this to (#236's closing comment).
      if (calendar.originType !== "local") return { ok: false, reason: "calendar_not_local" };
      if (intent.mailAccountId !== null) {
        const ownerId = await getMailAccountOwnerId(db, intent.mailAccountId);
        if (ownerId !== userId) return { ok: false, reason: "mail_account_not_found" };
      }
      await db
        .update(calendars)
        .set({ mailAccountId: intent.mailAccountId, updatedAt: new Date() })
        .where(eq(calendars.id, intent.calendarId));
      return { ok: true };
    }
    // Reminder settings (#244, ADR-0028) — Wicket-owned fields, applied
    // unconditionally regardless of `capabilities.writable` the same
    // "never pushed upstream at all" reasoning `setCalendarColor` already
    // has above.
    case "setCalendarRemindersEnabled": {
      const calendar = await calendarRow(db, userId, intent.calendarId);
      if (!calendar) return { ok: false, reason: "calendar_not_found" };
      await db
        .update(calendars)
        .set({ remindersEnabled: intent.enabled, updatedAt: new Date() })
        .where(eq(calendars.id, intent.calendarId));
      // "The table rebuilds on a change to... the Calendar toggle" (#245,
      // ADR-0028) — off drops every Reminder Due row for this Calendar
      // outright, on rebuilds them fresh, both inside the same sweep.
      await rebuildReminderDueForCalendar(db, intent.calendarId);
      return { ok: true };
    }
    case "setCalendarReminderDefault": {
      const calendar = await calendarRow(db, userId, intent.calendarId);
      if (!calendar) return { ok: false, reason: "calendar_not_found" };
      await db
        .update(calendars)
        .set({ reminderDefault: intent.reminderDefault, updatedAt: new Date() })
        .where(eq(calendars.id, intent.calendarId));
      await rebuildReminderDueForCalendar(db, intent.calendarId);
      return { ok: true };
    }
    // The Snooze toast, the Event page, and `routes/push.ts`'s own direct
    // POST for the OS notification's button (#246, ADR-0028) all resolve to
    // this one call per fired row a Snooze request names; a group snooze
    // (several Reminders sharing one notification) applies each
    // independently so one Occurrence already gone doesn't sink the rest.
    case "snoozeReminder": {
      let applied = false;
      let lastReason: string | undefined;
      for (const reminderDueId of intent.reminderDueIds) {
        const result = await snoozeReminderDue(db, userId, reminderDueId, intent.snoozeUntil);
        if (result.ok) applied = true;
        else lastReason = result.reason;
      }
      return applied ? { ok: true } : { ok: false, reason: lastReason ?? "reminder_not_found" };
    }
  }
}

async function noteRow(
  db: Db,
  userId: string,
  noteId: string,
): Promise<{ labelIds: string[] } | null> {
  const [row] = await db
    .select({ labelIds: notes.labelIds })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** `taskListRow`/`taskRow`: `noteRow`'s own shape, the lookup-and-ownership-check every Task List/Task intent above starts from. */
async function taskListRow(
  db: Db,
  userId: string,
  taskListId: string,
): Promise<{ sections: TaskSection[]; isDefault: boolean } | null> {
  const [row] = await db
    .select({ sections: taskLists.sections, isDefault: taskLists.isDefault })
    .from(taskLists)
    .where(and(eq(taskLists.id, taskListId), eq(taskLists.userId, userId)))
    .limit(1);
  return row ?? null;
}

async function taskRow(
  db: Db,
  userId: string,
  taskId: string,
): Promise<{ taskListId: string; labelIds: string[] } | null> {
  const [row] = await db
    .select({ taskListId: tasks.taskListId, labelIds: tasks.labelIds })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** This User's own Calendar row, or `null` for a bad id or someone else's Calendar — the same ownership guard every `case` above needs before touching one. */
async function calendarRow(db: Db, userId: string, calendarId: string) {
  const [row] = await db
    .select()
    .from(calendars)
    .where(and(eq(calendars.id, calendarId), eq(calendars.userId, userId)))
    .limit(1);
  return row ?? null;
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
