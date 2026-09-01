import { randomUUID } from "node:crypto";
import { isSyntacticallyValidAddress } from "@mail/shared";
import { and, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type CompositionRow, compositions } from "../db/schema.js";
import { recordTombstones } from "../sync/tombstones.js";

/**
 * The Pending Send state machine (ADR-0007, #46) — the transitions only,
 * with no IMAP or SMTP anywhere in this file. `compose/submit.ts` is what
 * actually talks to a mail server, and `compose/send-sweeper.ts` is the loop
 * that puts the two together.
 *
 * Every transition here is a **conditional** `UPDATE ... WHERE status = ?`
 * that reports whether it matched, rather than a read-then-write. That is
 * what makes ADR-0007's "the transition to `submitting` is an atomic claim
 * taken before the message is handed to Nodemailer" true against a second
 * sweeper tick, a second process, or a cancel landing in the same
 * millisecond: Postgres serialises the two updates on the row, exactly one
 * wins, and the loser is told it lost.
 */

/** How long a `sent` row lingers before it is tombstoned — see `pruneSentCompositions`. */
export const SENT_RETENTION_MS = 120_000;

/**
 * Transient-failure backoff (ADR-0007: "transient errors retry with backoff
 * inside `submitting`"). Doubling from 30s, capped so a mail server down for
 * an hour is still retried on the hour rather than drifting to a day.
 */
export const RETRY_BASE_MS = 30_000;
export const RETRY_CAP_MS = 15 * 60_000;

/**
 * After this many transient failures the send is treated as permanent and
 * returned to the User as a badged Draft. A mail nobody is told about is the
 * failure mode compose-spec calls "the highest-stakes silent failure in the
 * product" — retrying forever in silence is exactly that failure with extra
 * steps.
 */
export const MAX_SEND_ATTEMPTS = 8;

export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export type AcceptSendResult =
  | { status: "accepted"; submitAfter: Date }
  | { status: "rejected"; reason: "not_found" | "not_a_draft" | "no_recipients" };

/**
 * Accepts a send: `draft → pending` with an absolute `submit_after`.
 *
 * `delaySeconds` comes from the User's own preference and is applied to
 * *this server's* clock (ADR-0007: "the delay is measured from server
 * receipt, never from the Client's clock"). `0` — the `off` setting — is not
 * special-cased anywhere: it produces a row that is simply already due, so
 * the retry, Needs Reauth and failure-to-Draft paths below have exactly one
 * implementation, which is the whole reason ADR-0007 rejected a synchronous
 * bypass.
 *
 * A Composition with no *syntactically valid* recipient is rejected
 * permanently rather than queued (compose-spec §Send-time validation:
 * "blocking — no syntactically valid recipient") — a non-empty recipient
 * list of only garbage addresses (e.g. a partially-typed chip the composer
 * let through) is exactly as unsendable as an empty one, so this checks
 * validity, not just presence. The Client blocks this in the composer; this
 * is the backend's own re-check, and a rejection the Client shows rather
 * than retries.
 */
export async function acceptSend(
  db: Db,
  mailAccountId: string,
  compositionId: string,
  delaySeconds: number,
  now: Date = new Date(),
): Promise<AcceptSendResult> {
  const [row] = await db
    .select()
    .from(compositions)
    .where(and(eq(compositions.id, compositionId), eq(compositions.mailAccountId, mailAccountId)))
    .limit(1);
  if (!row) return { status: "rejected", reason: "not_found" };
  if (!hasValidRecipient(row)) return { status: "rejected", reason: "no_recipients" };

  const submitAfter = new Date(now.getTime() + delaySeconds * 1000);
  const updated = await db
    .update(compositions)
    .set({
      status: "pending",
      submitAfter,
      // A previous permanent failure's badge clears the moment the User
      // sends again — the banner compose-spec asks to keep "until resolved"
      // is resolved by exactly this.
      sendError: null,
      sendAttempts: 0,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(and(eq(compositions.id, compositionId), eq(compositions.status, "draft")))
    .returning({ id: compositions.id });

  if (updated.length === 0) return { status: "rejected", reason: "not_a_draft" };
  return { status: "accepted", submitAfter };
}

export type CancelSendResult =
  | { status: "cancelled" }
  | { status: "rejected"; reason: "not_found" | "too_late" };

/**
 * Undo Send: `pending → draft`, restoring the content untouched (ADR-0007:
 * "cancelling is a status change on the same content").
 *
 * The `status = 'pending'` predicate is the whole of the "a cancel arriving
 * after the claim loses" rule. Once `claimDueSends` has moved the row to
 * `submitting` this update matches nothing, and the User is told the send
 * was already on its way rather than being shown a cancel that silently did
 * nothing. `submitting` is deliberately *not* cancellable even before the
 * SMTP conversation starts: submission, not timer expiry, is ADR-0007's
 * point of no return, and the claim is where that begins.
 */
export async function cancelSend(
  db: Db,
  mailAccountId: string,
  compositionId: string,
): Promise<CancelSendResult> {
  const cancelled = await db
    .update(compositions)
    .set({ status: "draft", submitAfter: null, updatedAt: new Date() })
    .where(
      and(
        eq(compositions.id, compositionId),
        eq(compositions.mailAccountId, mailAccountId),
        eq(compositions.status, "pending"),
      ),
    )
    .returning({ id: compositions.id });
  if (cancelled.length > 0) return { status: "cancelled" };

  const [row] = await db
    .select({ status: compositions.status })
    .from(compositions)
    .where(and(eq(compositions.id, compositionId), eq(compositions.mailAccountId, mailAccountId)))
    .limit(1);
  if (!row) return { status: "rejected", reason: "not_found" };
  return { status: "rejected", reason: "too_late" };
}

/**
 * Every row the sweeper should look at right now, across every Mail Account
 * on the instance: `pending` rows whose `submit_after` has passed, plus
 * `submitting` rows whose transient-retry backoff has elapsed.
 *
 * Nothing here filters on account status — a Needs Reauth account's rows are
 * returned and then declined at claim time (`claimSend`), so the "hold
 * indefinitely" rule lives in exactly one place rather than being duplicated
 * in every candidate query.
 */
export async function dueSendCandidateIds(db: Db, now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({ id: compositions.id })
    .from(compositions)
    .where(isDue(now))
    .orderBy(compositions.submitAfter);
  return rows.map((row) => row.id);
}

/**
 * The atomic claim (ADR-0007). Moves one due row to `submitting` and mints
 * its `Message-ID` in the *same statement* that takes the claim, so the id
 * is durable before Nodemailer ever sees the mail and a retry can never
 * produce two messages with two ids (compose-spec §Threading headers).
 * `coalesce` is what makes a retry's re-claim re-use the first attempt's id.
 *
 * The predicate is the same due-ness test `dueSendCandidateIds` runs, not
 * just a status check, and it clears `nextAttemptAt` — so a `submitting` row
 * with no scheduled retry is one currently *inside* an SMTP conversation and
 * cannot be claimed at all. That is what makes "exactly once" hold against
 * two sweeps running at once (two app processes, or an overlapping tick),
 * not merely against two ticks that happen to be sequential.
 *
 * `null` means the claim was lost — cancelled a moment ago, already claimed,
 * not due yet, or the row is gone. The caller does nothing: it is not this
 * sweep's mail any more.
 */
export async function claimSend(
  db: Db,
  compositionId: string,
  mintMessageId: () => string,
  now: Date = new Date(),
): Promise<CompositionRow | null> {
  const [row] = await db
    .update(compositions)
    .set({
      status: "submitting",
      messageId: sql`coalesce(${compositions.messageId}, ${mintMessageId()})`,
      sendAttempts: sql`${compositions.sendAttempts} + 1`,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(and(eq(compositions.id, compositionId), isDue(now)))
    .returning();
  return row ?? null;
}

/** The one due-ness predicate, shared by the candidate query and the claim so they can never disagree. */
function isDue(now: Date) {
  return or(
    and(eq(compositions.status, "pending"), lte(compositions.submitAfter, now)),
    and(
      eq(compositions.status, "submitting"),
      isNotNull(compositions.nextAttemptAt),
      lte(compositions.nextAttemptAt, now),
    ),
  );
}

/**
 * `Message-ID` in the RFC 5322 shape, domain-qualified to the sending Mail
 * Account so it is globally unique and plausibly attributable. Returns the
 * addr-spec without angle brackets, matching `sync/message-ids.ts`'s
 * normalized storage form; the MIME builder is what adds the brackets.
 */
export function mintMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@")[1] ?? "mail.invalid";
  return `${randomUUID()}@${domain}`;
}

/** Success: the `Sent` APPEND landed and the IMAP draft copy is gone (ADR-0012's lifecycle step). */
export async function markSent(db: Db, compositionId: string, now: Date = new Date()) {
  await db
    .update(compositions)
    .set({
      status: "sent",
      sentAt: now,
      submitAfter: null,
      nextAttemptAt: null,
      sendError: null,
      imapDraftUid: null,
      updatedAt: now,
    })
    .where(eq(compositions.id, compositionId));
}

/**
 * A permanent rejection: back to `draft`, badged with the server's text
 * **verbatim** (compose-spec: "`550 5.7.1 relay denied` is actionable,
 * 'something went wrong' is not"). `submitting → draft` rather than a
 * terminal state because ADR-0007 says the Composition is *restored as a
 * Draft* — the User's next move is to fix the address and send again, which
 * needs the row editable and autosavable, and the badge is `sendError`.
 *
 * `messageId` is deliberately left on the row: if the User sends again the
 * same id is re-used, so a rejection that in fact reached some recipients
 * before failing does not become two different messages.
 */
export async function markPermanentFailure(
  db: Db,
  compositionId: string,
  rejection: string,
  now: Date = new Date(),
) {
  await db
    .update(compositions)
    .set({
      status: "draft",
      submitAfter: null,
      nextAttemptAt: null,
      sendError: rejection,
      updatedAt: now,
    })
    .where(eq(compositions.id, compositionId));
}

/**
 * A transient failure: stays `submitting` (ADR-0007 keeps the retry *inside*
 * the claimed state, so a cancel still loses) with the next attempt
 * scheduled. `sendError` is written too — a send that has been retrying for
 * ten minutes is worth showing, and it is cleared by the eventual success.
 */
export async function scheduleRetry(
  db: Db,
  row: CompositionRow,
  detail: string,
  now: Date = new Date(),
): Promise<{ retrying: boolean }> {
  if (row.sendAttempts >= MAX_SEND_ATTEMPTS) {
    await markPermanentFailure(db, row.id, detail, now);
    return { retrying: false };
  }
  await db
    .update(compositions)
    .set({
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(row.sendAttempts)),
      sendError: detail,
      updatedAt: now,
    })
    .where(eq(compositions.id, row.id));
  return { retrying: true };
}

/**
 * A Needs Reauth account holds its Pending Sends **indefinitely** (ADR-0007,
 * consistent with the queued-Optimistic-Action rule in CONTEXT.md): the row
 * goes back to `pending`, already due, so the very next sweep after the User
 * re-authenticates picks it up. No attempt is counted against it — waiting
 * for a password is not a failure to send.
 */
export async function releaseForReauth(db: Db, row: CompositionRow, now: Date = new Date()) {
  await db
    .update(compositions)
    .set({
      status: "pending",
      submitAfter: row.submitAfter ?? now,
      sendAttempts: Math.max(0, row.sendAttempts - 1),
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(eq(compositions.id, row.id));
}

export function recipientCount(row: CompositionRow): number {
  return row.toAddresses.length + row.ccAddresses.length + row.bccAddresses.length;
}

/**
 * Whether a Composition has at least one *syntactically valid* recipient
 * (compose-spec §Send-time validation) — `recipientCount` above only checks
 * presence, which a Composition holding nothing but malformed addresses
 * (e.g. a partial chip the composer's own race let through, #4) would still
 * pass, sailing into `pending`/`submitting` only to fail later as an SMTP
 * rejection instead of being caught here.
 */
export function hasValidRecipient(row: CompositionRow): boolean {
  return [...row.toAddresses, ...row.ccAddresses, ...row.bccAddresses].some((recipient) =>
    isSyntacticallyValidAddress(recipient.address),
  );
}

/**
 * Retires `sent` Compositions. A sent Composition has done its job — the
 * message in the account's `Sent` folder is the record now (ADR-0012's
 * lifecycle: the draft copy is expunged and the blobs dropped in the same
 * step as the APPEND) — but it lingers for `SENT_RETENTION_MS` first so a
 * device that was watching the countdown gets at least one sync round in
 * which the row reads `sent` rather than simply vanishing mid-count.
 *
 * The delete is paired with a tombstone in the same call, because that is
 * the only thing that tells a Client the row is gone (ADR-0011's
 * `destroyed`) — dropping the row silently would leave a "sent" Composition
 * in every Local Cache forever.
 */
export async function pruneSentCompositions(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SENT_RETENTION_MS);
  const rows = await db
    .select({ id: compositions.id, mailAccountId: compositions.mailAccountId })
    .from(compositions)
    .where(and(eq(compositions.status, "sent"), lte(compositions.sentAt, cutoff)));
  if (rows.length === 0) return 0;

  const byAccount = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byAccount.get(row.mailAccountId) ?? [];
    ids.push(row.id);
    byAccount.set(row.mailAccountId, ids);
  }
  for (const [mailAccountId, entityIds] of byAccount) {
    await recordTombstones(db, { mailAccountId, collection: "Composition", entityIds });
  }
  await db.delete(compositions).where(
    inArray(
      compositions.id,
      rows.map((row) => row.id),
    ),
  );
  return rows.length;
}
