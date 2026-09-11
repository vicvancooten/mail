import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type ImipRequestRow, imipRequests, type SeriesRow, series } from "../db/schema.js";
import { buildOrganizerIcs, type OrganizerIcsAttendee } from "./organizer-ics.js";

/**
 * Queuing the organiser-side iMIP `REQUEST`/`CANCEL` (#242, ADR-0027) — the
 * mirror image of `local-answer.ts#answerLocalInvitation`: that one *is* a
 * `REPLY`, this one *is* the scheduling mail an Attendee's own `REPLY`
 * answers. Sent at once (no Undo Send delay) — the "Send / Don't send"
 * prompt `calendars/series-store.ts#sendOrganizerUpdates` gates this on is
 * already the User's chance to reconsider, unlike an Answer which has none.
 */

export interface OrganizerIdentity {
  mailAccountId: string;
  address: string;
  name: string | null;
}

export interface QueueOrganizerSendInput {
  method: "REQUEST" | "CANCEL";
  recipients: OrganizerIcsAttendee[];
  recurrenceId?: string | null;
  /** Whether this send bumps `series.sequence` before building the `.ics` — never for the very first organiser send (ADR-0027: "`SEQUENCE` bumps on every organiser-side send after the first"). */
  bumpSequence: boolean;
}

export interface QueueOrganizerSendResult {
  sequence: number;
  requestIds: string[];
}

/** Bumps `series.sequence` when asked, builds one shared `.ics` body, and queues one `imip_requests` row per recipient — a no-op when `recipients` is empty. */
export async function queueOrganizerSend(
  db: Db,
  userId: string,
  row: SeriesRow,
  organizer: OrganizerIdentity,
  input: QueueOrganizerSendInput,
): Promise<QueueOrganizerSendResult> {
  if (input.recipients.length === 0) return { sequence: row.sequence, requestIds: [] };

  let sequence = row.sequence;
  if (input.bumpSequence) {
    sequence = row.sequence + 1;
    await db.update(series).set({ sequence, updatedAt: new Date() }).where(eq(series.id, row.id));
  }

  const icsText = buildOrganizerIcs({
    method: input.method,
    uid: row.uid,
    sequence,
    organizer: { address: organizer.address, name: organizer.name },
    attendees: input.recipients,
    summary: row.title,
    description: row.description,
    location: row.location,
    dtstart: row.dtstart,
    durationMs: row.durationMs,
    allDay: row.allDay,
    floating: row.floating,
    tzid: row.tzid,
    rrules: row.rrules,
    rdates: row.rdates,
    exdates: row.exdates,
    recurrenceId: input.recurrenceId ?? null,
  });

  const now = new Date();
  const requestIds: string[] = [];
  const values = input.recipients.map((recipient) => {
    const id = randomUUID();
    requestIds.push(id);
    return {
      id,
      userId,
      seriesId: row.id,
      mailAccountId: organizer.mailAccountId,
      method: input.method,
      organizerAddress: organizer.address,
      organizerName: organizer.name,
      attendeeAddress: recipient.address,
      attendeeName: recipient.name,
      uid: row.uid,
      sequence,
      recurrenceId: input.recurrenceId ?? "",
      eventTitle: row.title,
      icsText,
      status: "pending" as const,
      submitAfter: now,
      updatedAt: now,
    };
  });
  await db.insert(imipRequests).values(values);

  return { sequence, requestIds };
}

/** Every Request due for the sweeper right now — `local-answer.ts#dueReplyCandidateIds`'s own due-ness shape. */
export async function dueRequestCandidateIds(db: Db, now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({ id: imipRequests.id })
    .from(imipRequests)
    .where(isDue(now))
    .orderBy(imipRequests.submitAfter);
  return rows.map((row) => row.id);
}

export async function claimRequest(
  db: Db,
  requestId: string,
  mintMessageId: () => string,
  now: Date = new Date(),
): Promise<ImipRequestRow | null> {
  const [row] = await db
    .update(imipRequests)
    .set({
      status: "submitting",
      messageId: sql`coalesce(${imipRequests.messageId}, ${mintMessageId()})`,
      sendAttempts: sql`${imipRequests.sendAttempts} + 1`,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(and(eq(imipRequests.id, requestId), isDue(now)))
    .returning();
  return row ?? null;
}

function isDue(now: Date) {
  return or(
    and(eq(imipRequests.status, "pending"), lte(imipRequests.submitAfter, now)),
    and(
      eq(imipRequests.status, "submitting"),
      isNotNull(imipRequests.nextAttemptAt),
      lte(imipRequests.nextAttemptAt, now),
    ),
  );
}

export async function markRequestSent(db: Db, requestId: string, now: Date = new Date()) {
  await db
    .update(imipRequests)
    .set({ status: "sent", nextAttemptAt: null, sendError: null, updatedAt: now })
    .where(eq(imipRequests.id, requestId));
}

const MAX_REQUEST_SEND_ATTEMPTS = 8;
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 15 * 60_000;

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export async function markRequestPermanentFailure(
  db: Db,
  requestId: string,
  detail: string,
  now: Date = new Date(),
) {
  await db
    .update(imipRequests)
    .set({ status: "cancelled", sendError: detail, nextAttemptAt: null, updatedAt: now })
    .where(eq(imipRequests.id, requestId));
}

export async function scheduleRequestRetry(
  db: Db,
  row: ImipRequestRow,
  detail: string,
  now: Date = new Date(),
): Promise<{ retrying: boolean }> {
  if (row.sendAttempts >= MAX_REQUEST_SEND_ATTEMPTS) {
    await markRequestPermanentFailure(db, row.id, detail, now);
    return { retrying: false };
  }
  await db
    .update(imipRequests)
    .set({
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(row.sendAttempts)),
      sendError: detail,
      updatedAt: now,
    })
    .where(eq(imipRequests.id, row.id));
  return { retrying: true };
}

/** A Needs Reauth Mail Account holds its queued Requests indefinitely, same posture `local-answer.ts#releaseReplyForReauth` gives a Reply. */
export async function releaseRequestForReauth(db: Db, row: ImipRequestRow, now: Date = new Date()) {
  await db
    .update(imipRequests)
    .set({
      status: "pending",
      submitAfter: row.submitAfter ?? now,
      sendAttempts: Math.max(0, row.sendAttempts - 1),
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(eq(imipRequests.id, row.id));
}

/** Retires old `sent`/`cancelled` rows — `local-answer.ts#pruneSettledReplies`'s own shape. */
export async function pruneSettledRequests(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 120_000);
  const result = await db
    .delete(imipRequests)
    .where(
      and(
        or(eq(imipRequests.status, "sent"), eq(imipRequests.status, "cancelled")),
        lte(imipRequests.updatedAt, cutoff),
      ),
    )
    .returning({ id: imipRequests.id });
  return result.length;
}
