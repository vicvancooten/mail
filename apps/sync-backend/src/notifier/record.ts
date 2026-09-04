import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { messages, notifierOutbox } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import type { FolderRow } from "../sync/folders.js";
import { insertOutboxEntry } from "./outbox.js";
import {
  GATEKEEPER_DIGEST_SENDER_CAP,
  GATEKEEPER_DIGEST_SILENCE_MS,
  isInboxArrival,
} from "./policy.js";

/**
 * Where the sync engine's three arrival paths (`sync/delta.ts`,
 * `sync/qresync-catchup.ts`) hand off to the Notifier (#53, ADR-0015): "only
 * messages arriving via IDLE/delta on an already-live folder are
 * notification-eligible" is a fact about *which functions call this*, not a
 * flag threaded through `storeMessage` — see those two modules' call sites,
 * both right after a message is newly stored, never from `sync/ingest.ts`'s
 * backfill path.
 *
 * Takes ids rather than full rows so the two call sites don't each need
 * their own re-select of `fromName`/`fromAddress`/`subject`/`snippet` — this
 * is the one place that query lives.
 */
export async function recordNewMailNotifications(
  db: Db,
  folder: Pick<FolderRow, "mailAccountId" | "role">,
  account: Pick<MailAccountRow, "id" | "userId" | "notificationsEnabled">,
  /**
   * Already screened (#55): `sync/arrivals.ts` hands over only what
   * Gatekeeper let through, so held and blocked mail never reaches this
   * function at all — see `policy.ts#isInboxArrival` for why the sender check
   * lives there and not here.
   */
  createdMessageIds: string[],
): Promise<void> {
  if (createdMessageIds.length === 0) return;
  // The per-Mail-Account toggle (#54) is "the entire preference surface"
  // (poc-scope.md) for new-mail pushes — gated here, before the Inbox check,
  // so a disabled account never even queries for content.
  if (!account.notificationsEnabled) return;

  const rows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      fromName: messages.fromName,
      fromAddress: messages.fromAddress,
      subject: messages.subject,
      snippet: messages.snippet,
      gmailLabels: messages.gmailLabels,
    })
    .from(messages)
    .where(inArray(messages.id, createdMessageIds));

  for (const row of rows) {
    // Per-message, not per-folder (#125) — see `policy.ts#isInboxArrival`.
    if (!isInboxArrival(folder.role, row.gmailLabels)) continue;
    await insertOutboxEntry(db, {
      userId: account.userId,
      mailAccountId: account.id,
      kind: "new_mail",
      // The Message's own id: already exactly-once per message by
      // construction (`messages_folder_uid_key`'s uniqueness), so this is a
      // backstop against a double-call within one delta pass, not the real
      // dedup guarantee — see `db/schema.ts`'s doc comment.
      dedupKey: row.id,
      payload: {
        kind: "new_mail",
        threadId: row.threadId,
        senderName: row.fromName,
        senderAddress: row.fromAddress,
        subject: row.subject,
        snippet: row.snippet,
      },
    });
  }
}

/**
 * The coalesced Gatekeeper digest (#55, poc-scope.md, ADR-0015): "one
 * coalesced Gatekeeper notification naming the senders ('3 held: A, B, C'),
 * on the first hold, then suppressed for 4 hours". This is the only push a
 * Screening Hold ever produces — a held stranger never fires `new_mail`,
 * which is the point of holding them.
 *
 * The 4-hour silence is read straight off this table rather than kept as a
 * column somewhere: the most recent `gatekeeper_digest` row for the account
 * *is* the record of when the User was last told, and it survives a restart
 * for free the way every other fact in the outbox does. The window is
 * measured from when a digest was **recorded**, not delivered, so a device
 * that was unreachable does not entitle the next hold to interrupt again.
 *
 * `dedupKey` is the recording instant, so two digests four hours apart are
 * two genuinely different events — the same reasoning `needs_reauth` uses
 * for putting its transition instant in the key rather than the bare account
 * id.
 */
export async function recordGatekeeperDigest(
  db: Db,
  account: Pick<MailAccountRow, "id" | "userId" | "notificationsEnabled">,
  heldSenders: { address: string; name: string | null }[],
  now: Date = new Date(),
): Promise<boolean> {
  if (heldSenders.length === 0) return false;
  if (!account.notificationsEnabled) return false;

  const [recent] = await db
    .select({ id: notifierOutbox.id })
    .from(notifierOutbox)
    .where(
      and(
        eq(notifierOutbox.mailAccountId, account.id),
        eq(notifierOutbox.kind, "gatekeeper_digest"),
        gte(notifierOutbox.createdAt, new Date(now.getTime() - GATEKEEPER_DIGEST_SILENCE_MS)),
      ),
    )
    .orderBy(desc(notifierOutbox.createdAt))
    .limit(1);
  if (recent) return false;

  return insertOutboxEntry(db, {
    userId: account.userId,
    mailAccountId: account.id,
    kind: "gatekeeper_digest",
    dedupKey: `${account.id}:${now.toISOString()}`,
    payload: {
      kind: "gatekeeper_digest",
      // Display name where the mail carried one, address otherwise: a
      // notification that reads "3 held: Ada, grace@example.com" is how the
      // User recognizes whether any of this is worth opening.
      senders: heldSenders
        .slice(0, GATEKEEPER_DIGEST_SENDER_CAP)
        .map((sender) => sender.name ?? sender.address),
      count: heldSenders.length,
    },
  });
}

/**
 * "A Mail Account entering Needs Reauth" (ADR-0015), fired only on a genuine
 * transition — `mail-accounts/store.ts#markNeedsReauth` already does the
 * atomic conditional check ("`WHERE status != 'needs_reauth'`") and hands
 * back the updated row only when one actually happened, so this function's
 * job is just building the notification from it, never re-checking.
 */
export async function recordNeedsReauthNotification(
  db: Db,
  account: Pick<MailAccountRow, "id" | "userId" | "emailAddress" | "updatedAt">,
): Promise<void> {
  await insertOutboxEntry(db, {
    userId: account.userId,
    mailAccountId: account.id,
    kind: "needs_reauth",
    // Not the bare Mail Account id: a *later*, separate transition into
    // Needs Reauth for the same account (reauth, then rejected again) is a
    // genuine new event, not a repeat of the first — see the schema's doc
    // comment on why the transition instant is part of the key.
    dedupKey: `${account.id}:${account.updatedAt.toISOString()}`,
    payload: { kind: "needs_reauth", emailAddress: account.emailAddress },
  });
}

/**
 * "A permanently failed send" (ADR-0007's own requirement on this design):
 * `compose/send-sweeper.ts#sweepOne` calls this right after
 * `compose/pending-send.ts#markPermanentFailure`, which only ever runs once
 * per atomic send claim — see that module's own doc comment.
 */
export async function recordFailedSendNotification(
  db: Db,
  account: Pick<MailAccountRow, "id" | "userId">,
  composition: { id: string; subject: string },
  detail: string,
): Promise<void> {
  await insertOutboxEntry(db, {
    userId: account.userId,
    mailAccountId: account.id,
    kind: "failed_send",
    // "Once per Composition" (ADR-0015), literally: a second permanent
    // failure on the same Composition after a resend shares this key and is
    // absorbed rather than re-notified. Accepted — untested by this
    // ticket's acceptance bar, and the Draft's own "Send failed" badge
    // (compose-spec) still carries the rejection either way.
    dedupKey: composition.id,
    payload: {
      kind: "failed_send",
      compositionId: composition.id,
      subject: composition.subject,
      detail,
    },
  });
}
