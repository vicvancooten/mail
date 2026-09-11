import { randomUUID } from "node:crypto";
import {
  DEFAULT_UNDO_SEND_DELAY_SECONDS,
  UNDO_SEND_DELAY_OPTIONS,
  type UndoSendDelaySeconds,
} from "@mail/shared";
import { and, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  calendars,
  type ImipReplyRow,
  imipReplies,
  invitations,
  mailAccounts,
  type SeriesRow,
  series,
  users,
} from "../db/schema.js";
import { normalizeAddress } from "./local-fallback.js";
import { buildReplyIcs } from "./reply-ics.js";

/**
 * Answering on a Local Calendar (#241, ADR-0027) — the fallback complement
 * to #240's `calendars/series-store.ts#answerInvitation`. That one pushes an
 * Event edit an upstream turns into its own `REPLY`; this one *is* the
 * `REPLY`, queued on `imip_replies` and held for the User's Undo Send delay
 * exactly like a Composition (ADR-0007) — except it is never a Composition,
 * so it gets this file's own minimal Pending Send state machine rather than
 * riding `compose/pending-send.ts`.
 */

export type LocalResponseStatus = "accepted" | "declined" | "tentative";

export type AnswerLocalInvitationResult =
  | {
      ok: true;
      previousResponseStatus: SeriesRow["attendees"][number]["responseStatus"];
      replyId: string;
    }
  | { ok: false; reason: "series_not_found" | "not_local" | "not_attendee" | "no_mail_account" };

/**
 * The owning User's Undo Send delay, the same clamp
 * `sync/mutations.ts#undoSendDelayForAccount` applies to a Composition's own
 * Pending Send — a `REPLY` waits exactly as long as an ordinary send does
 * (ADR-0027: "held for the User's Undo Send delay").
 */
async function undoSendDelaySeconds(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ delay: users.undoSendDelaySeconds })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const delay = row?.delay ?? DEFAULT_UNDO_SEND_DELAY_SECONDS;
  return UNDO_SEND_DELAY_OPTIONS.includes(delay as UndoSendDelaySeconds)
    ? delay
    : DEFAULT_UNDO_SEND_DELAY_SECONDS;
}

/**
 * Answers an Invitation on a Local Calendar's Series: updates the Series'
 * own Attendee entry (the same optimistic-update shape #240's synced
 * `answerInvitation` gives the Reader card) and queues one `imip_replies`
 * row through the Mail Account matching the invited address — never an
 * Alias as `From` (ADR-0027), the Mail Account's own address is the only
 * choice this reads.
 *
 * Any Reply still `pending` for this Series is superseded outright — "a
 * later Answer while the first is still held is a new REPLY" reads
 * literally here: the stale one is cancelled so only the latest Answer's
 * mail ever goes out, never both.
 */
export async function answerLocalInvitation(
  db: Db,
  userId: string,
  seriesId: string,
  responseStatus: LocalResponseStatus,
): Promise<AnswerLocalInvitationResult> {
  const [row] = await db
    .select()
    .from(series)
    .where(and(eq(series.id, seriesId), eq(series.userId, userId)));
  if (!row) return { ok: false, reason: "series_not_found" };

  const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, row.calendarId));
  if (calendarRow?.originType !== "local") return { ok: false, reason: "not_local" };
  if (!calendarRow.mailAccountId) return { ok: false, reason: "no_mail_account" };

  const [mailAccount] = await db
    .select()
    .from(mailAccounts)
    .where(eq(mailAccounts.id, calendarRow.mailAccountId));
  if (!mailAccount) return { ok: false, reason: "no_mail_account" };

  const normalizedSelf = normalizeAddress(mailAccount.emailAddress);
  const index = row.attendees.findIndex(
    (attendee) => normalizeAddress(attendee.email) === normalizedSelf,
  );
  if (index === -1) return { ok: false, reason: "not_attendee" };
  const attendee = row.attendees[index];
  if (!attendee) return { ok: false, reason: "not_attendee" };

  const [latestRequest] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.uid, row.uid), eq(invitations.mailAccountId, mailAccount.id)))
    .orderBy(sql`${invitations.sequence} desc`, sql`${invitations.dtstamp} desc`)
    .limit(1);

  const previousResponseStatus = attendee.responseStatus;
  const nextAttendees = row.attendees.map((entry, i) =>
    i === index ? { ...entry, responseStatus } : entry,
  );
  await db
    .update(series)
    .set({ attendees: nextAttendees, updatedAt: new Date() })
    .where(eq(series.id, seriesId));

  // A later Answer supersedes any Reply this Series still has held.
  await db
    .update(imipReplies)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(imipReplies.seriesId, seriesId), eq(imipReplies.status, "pending")));

  const icsText = buildReplyIcs({
    uid: row.uid,
    sequence: latestRequest?.sequence ?? row.sequence,
    organizer: latestRequest?.organizer ?? null,
    attendeeAddress: attendee.email,
    attendeeName: attendee.name,
    responseStatus,
    summary: row.title,
  });

  const delaySeconds = await undoSendDelaySeconds(db, userId);
  const replyId = randomUUID();
  const now = new Date();
  await db.insert(imipReplies).values({
    id: replyId,
    userId,
    seriesId,
    mailAccountId: mailAccount.id,
    organizerAddress: latestRequest?.organizer?.address ?? "",
    organizerName: latestRequest?.organizer?.name ?? null,
    attendeeAddress: attendee.email,
    uid: row.uid,
    sequence: latestRequest?.sequence ?? row.sequence,
    responseStatus,
    eventTitle: row.title,
    icsText,
    status: "pending",
    submitAfter: new Date(now.getTime() + delaySeconds * 1000),
    updatedAt: now,
  });

  return { ok: true, previousResponseStatus, replyId };
}

export type CancelReplyResult = { ok: true } | { ok: false; reason: "not_found" | "too_late" };

/**
 * Undo Send for a `REPLY` (ADR-0007, ADR-0027: "Undo cancels it outright") —
 * a true cancel, not a second Answer: the Series' own Attendee entry is
 * restored to whatever it held before (the caller's own `previousResponseStatus`,
 * `InviteCard.tsx`'s own Undo-toast closure), and the queued mail never goes
 * out at all. `too_late` once the sweeper has claimed the row (`submitting`
 * or `sent` already) — the same point-of-no-return `compose/pending-send
 * .ts#cancelSend` gives an ordinary send.
 */
export async function cancelLocalReply(
  db: Db,
  userId: string,
  replyId: string,
  previousResponseStatus: SeriesRow["attendees"][number]["responseStatus"],
): Promise<CancelReplyResult> {
  const cancelled = await db
    .update(imipReplies)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(imipReplies.id, replyId),
        eq(imipReplies.userId, userId),
        eq(imipReplies.status, "pending"),
      ),
    )
    .returning({ seriesId: imipReplies.seriesId, attendeeAddress: imipReplies.attendeeAddress });
  const cancelledRow = cancelled[0];
  if (!cancelledRow) {
    const [row] = await db
      .select({ id: imipReplies.id })
      .from(imipReplies)
      .where(and(eq(imipReplies.id, replyId), eq(imipReplies.userId, userId)));
    return row ? { ok: false, reason: "too_late" } : { ok: false, reason: "not_found" };
  }

  const [seriesRow] = await db.select().from(series).where(eq(series.id, cancelledRow.seriesId));
  if (seriesRow) {
    const normalizedAttendee = normalizeAddress(cancelledRow.attendeeAddress);
    const nextAttendees = seriesRow.attendees.map((entry) =>
      normalizeAddress(entry.email) === normalizedAttendee
        ? { ...entry, responseStatus: previousResponseStatus }
        : entry,
    );
    await db
      .update(series)
      .set({ attendees: nextAttendees, updatedAt: new Date() })
      .where(eq(series.id, seriesRow.id));
  }

  return { ok: true };
}

/** Every Reply due for the sweeper right now — the same due-ness shape `compose/pending-send.ts#dueSendCandidateIds` gives a Composition. */
export async function dueReplyCandidateIds(db: Db, now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({ id: imipReplies.id })
    .from(imipReplies)
    .where(isDue(now))
    .orderBy(imipReplies.submitAfter);
  return rows.map((row) => row.id);
}

export async function claimReply(
  db: Db,
  replyId: string,
  mintMessageId: () => string,
  now: Date = new Date(),
): Promise<ImipReplyRow | null> {
  const [row] = await db
    .update(imipReplies)
    .set({
      status: "submitting",
      messageId: sql`coalesce(${imipReplies.messageId}, ${mintMessageId()})`,
      sendAttempts: sql`${imipReplies.sendAttempts} + 1`,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(and(eq(imipReplies.id, replyId), isDue(now)))
    .returning();
  return row ?? null;
}

function isDue(now: Date) {
  return or(
    and(eq(imipReplies.status, "pending"), lte(imipReplies.submitAfter, now)),
    and(
      eq(imipReplies.status, "submitting"),
      isNotNull(imipReplies.nextAttemptAt),
      lte(imipReplies.nextAttemptAt, now),
    ),
  );
}

export async function markReplySent(db: Db, replyId: string, now: Date = new Date()) {
  await db
    .update(imipReplies)
    .set({ status: "sent", nextAttemptAt: null, sendError: null, updatedAt: now })
    .where(eq(imipReplies.id, replyId));
}

const MAX_REPLY_SEND_ATTEMPTS = 8;
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 15 * 60_000;

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export async function markReplyPermanentFailure(
  db: Db,
  replyId: string,
  detail: string,
  now: Date = new Date(),
) {
  await db
    .update(imipReplies)
    .set({ status: "cancelled", sendError: detail, nextAttemptAt: null, updatedAt: now })
    .where(eq(imipReplies.id, replyId));
}

export async function scheduleReplyRetry(
  db: Db,
  row: ImipReplyRow,
  detail: string,
  now: Date = new Date(),
): Promise<{ retrying: boolean }> {
  if (row.sendAttempts >= MAX_REPLY_SEND_ATTEMPTS) {
    await markReplyPermanentFailure(db, row.id, detail, now);
    return { retrying: false };
  }
  await db
    .update(imipReplies)
    .set({
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(row.sendAttempts)),
      sendError: detail,
      updatedAt: now,
    })
    .where(eq(imipReplies.id, row.id));
  return { retrying: true };
}

/** A Needs Reauth Mail Account holds its queued Replies indefinitely, same posture ADR-0007 gives a Composition. */
export async function releaseReplyForReauth(db: Db, row: ImipReplyRow, now: Date = new Date()) {
  await db
    .update(imipReplies)
    .set({
      status: "pending",
      submitAfter: row.submitAfter ?? now,
      sendAttempts: Math.max(0, row.sendAttempts - 1),
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(eq(imipReplies.id, row.id));
}

/** Retires old `sent`/`cancelled` rows — same "the record is `Sent` itself now" reasoning `compose/pending-send.ts#pruneSentCompositions` gives a Composition, minus the sync-collection tombstone (`imip_replies` is not one). */
export async function pruneSettledReplies(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 120_000);
  const result = await db
    .delete(imipReplies)
    .where(
      and(
        or(eq(imipReplies.status, "sent"), eq(imipReplies.status, "cancelled")),
        lte(imipReplies.updatedAt, cutoff),
      ),
    )
    .returning({ id: imipReplies.id });
  return result.length;
}
