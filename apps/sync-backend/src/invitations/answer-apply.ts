import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  events,
  type InvitationParticipant,
  mailAccounts,
  messages,
  series,
  threads,
  users,
} from "../db/schema.js";
import { recordCalendarAnswerNotification } from "../notifier/record.js";
import { selectInboxResidentMessageIds } from "../sync/inbox.js";
import { enqueueProtocolWrites } from "../sync/protocol-writes.js";
import { normalizeAddress } from "./local-fallback.js";

/**
 * "Answers arriving for Events the User organises" (#243, ADR-0027): the
 * organiser-side counterpart to `local-answer.ts#answerLocalInvitation` (an
 * Answer this User *sends*) and `local-fallback.ts` (an Invitation this User
 * *received*) — this is what happens when a `METHOD:REPLY` arrives *back*
 * for a Series this User organises.
 *
 * `invitations/store.ts#extractInvitations` is the one caller, right after
 * it stores a freshly-parsed `answer`-kind Invitation row — same call site
 * for both the eager-ingest and body-sweep paths, so a matched `REPLY` is
 * applied exactly once, at the same instant #239 first parses it.
 */

/** iMIP `PARTSTAT` → `SeriesAttendee.responseStatus` (`reply-ics.ts#PARTSTAT`'s own map, in reverse). `NEEDS-ACTION` and anything unrecognised answer nothing — a `REPLY` that names no real answer is not one this ticket updates a Series for. */
const RESPONSE_STATUS_BY_PARTSTAT: Record<string, "accepted" | "declined" | "tentative"> = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
};

export interface AnswerInvitationInput {
  mailAccountId: string;
  threadId: string;
  uid: string;
  /** `''` for "no `RECURRENCE-ID`" — `db/schema.ts#invitations`' own doc comment; a whole-Series Answer. */
  recurrenceId: string;
  /** The `REPLY`'s own `ATTENDEE` line(s) — RFC 6047 names exactly one, but this reads the first defensively rather than assume a foreign sender's mailer never adds a second. */
  attendees: InvitationParticipant[];
}

/**
 * Matches an arriving `REPLY` against an Event this User organises (`UID` +
 * `RECURRENCE-ID`, this ticket's own acceptance line), updates the Attendee's
 * Answer on the Series, marks the Thread Done, and records the coalesced
 * "Answer received" notification. A `REPLY` this can't match — no organised
 * Series shares the `UID`, the `RECURRENCE-ID` names no real Occurrence, or
 * the answering address isn't one of the Series' own Attendees — changes
 * nothing at all: "unmatched REPLYs stay in the Inbox" (this ticket's own
 * acceptance line) falls out for free, since nothing here ever touches the
 * Thread unless a match is found.
 */
export async function applyAnswerInvitation(
  db: Db,
  input: AnswerInvitationInput,
  now: Date = new Date(),
): Promise<void> {
  const responder = input.attendees[0];
  if (!responder?.partstat) return;
  const responseStatus = RESPONSE_STATUS_BY_PARTSTAT[responder.partstat.toUpperCase()];
  if (!responseStatus) return;

  const [mailAccount] = await db
    .select({ userId: mailAccounts.userId })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, input.mailAccountId));
  if (!mailAccount) return;

  const [seriesRow] = await db
    .select()
    .from(series)
    .where(
      and(
        eq(series.uid, input.uid),
        eq(series.userId, mailAccount.userId),
        isNull(series.deletedAt),
      ),
    )
    .limit(1);
  // `organizerFirstSentAt` is set only by `local-organizer.ts#queueOrganizerSend`
  // (#242) — the one writer, and only once this User's own organiser-side
  // `REQUEST` has actually gone out. A fallback Series #241 builds for an
  // Invitation this User was invited to never sets it, which is exactly what
  // tells the two apart: no organiser send ever went out for that Series, so
  // no `REPLY` could legitimately answer it either.
  if (!seriesRow?.organizerFirstSentAt) return;

  const eventId = await resolveOccurrenceId(db, seriesRow.id, input.recurrenceId);
  if (!eventId) return; // Names an Occurrence (or a whole Series) with nothing materialised yet — nothing to open, nothing matched.

  const normalizedResponder = normalizeAddress(responder.address);
  const index = seriesRow.attendees.findIndex(
    (attendee) => normalizeAddress(attendee.email) === normalizedResponder,
  );
  if (index === -1) return; // Answers for nobody this Series actually invited.
  const attendee = seriesRow.attendees[index];
  if (!attendee) return;

  const nextAttendees = seriesRow.attendees.map((entry, i) =>
    i === index ? { ...entry, responseStatus } : entry,
  );
  await db
    .update(series)
    .set({ attendees: nextAttendees, updatedAt: now })
    .where(eq(series.id, seriesRow.id));

  await markThreadDone(db, input.mailAccountId, input.threadId);

  const [userRow] = await db
    .select({ answerNotificationsEnabled: users.answerNotificationsEnabled })
    .from(users)
    .where(eq(users.id, mailAccount.userId));
  if (userRow?.answerNotificationsEnabled ?? true) {
    await recordCalendarAnswerNotification(
      db,
      {
        userId: mailAccount.userId,
        eventId,
        seriesId: seriesRow.id,
        title: seriesRow.title,
        attendeeEmail: attendee.email,
        attendeeName: attendee.name,
        responseStatus,
      },
      now,
    );
  }
}

/**
 * `RECURRENCE-ID` set names one Occurrence exactly — real only if this
 * Series actually has an Event row for that instant, `events.originalStart`
 * being the Occurrence's own identity (ADR-0025). Unset (`''`) answers the
 * whole Series, which this reads as "the earliest Occurrence this Series
 * has materialised" — the Event a click opens, since a flat `Series.attendees`
 * carries no per-Occurrence Answer of its own for a bare `REPLY` to disagree
 * with anyway.
 */
async function resolveOccurrenceId(
  db: Db,
  seriesId: string,
  recurrenceId: string,
): Promise<string | null> {
  if (recurrenceId) {
    const [row] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.seriesId, seriesId), eq(events.originalStart, new Date(recurrenceId))))
      .limit(1);
    return row?.id ?? null;
  }
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.seriesId, seriesId))
    .orderBy(asc(events.originalStart))
    .limit(1);
  return row?.id ?? null;
}

/**
 * "The Thread is marked Done automatically" (this ticket's own acceptance
 * line) — the exact same synchronous-ack shape `sync/bulk-triage.ts#applyDone`
 * gives a User-driven Done: `inInbox: false`/`folderRole: "archive"` land at
 * once, and the real IMAP move/Gmail label removal rides the ordinary
 * protocol-write outbox. A Thread already out of the Inbox (a duplicate
 * `REPLY` revision, say) is left alone rather than re-enqueuing a write —
 * the same idempotence `unsnooze`'s own guard gives a repeat call.
 */
async function markThreadDone(db: Db, mailAccountId: string, threadId: string): Promise<void> {
  const [thread] = await db
    .select({ inInbox: threads.inInbox })
    .from(threads)
    .where(eq(threads.id, threadId));
  if (!thread?.inInbox) return;

  await db
    .update(threads)
    .set({ inInbox: false, folderRole: "archive", snoozeUntil: null })
    .where(eq(threads.id, threadId));

  const inboxMessageIds = await selectInboxResidentMessageIds(db, eq(messages.threadId, threadId));
  await enqueueProtocolWrites(db, mailAccountId, inboxMessageIds, "archive");
}
