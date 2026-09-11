import type { InvitationCard, InvitationMatch } from "@mail/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  calendars,
  events,
  type InvitationRow,
  invitations,
  mailAccounts,
  messages,
  series,
} from "../db/schema.js";
import { ensureLocalFallbackSeries, findSelfAttendee, normalizeAddress } from "./local-fallback.js";

/**
 * The Reader's invite card (#240, ADR-0027): every distinct `UID` an
 * Invitation (#239) names in a Thread, at its highest-`SEQUENCE`/`DTSTAMP`
 * revision only — "revisions of one `UID` in a Thread are ordered by
 * `SEQUENCE` then `DTSTAMP`" (`invitations/store.ts#latestInvitationRevision`'s
 * own doc comment), generalized across every `UID` a Thread might carry
 * rather than one at a time.
 */
export async function latestInvitationRevisionsForThread(
  db: Db,
  threadId: string,
): Promise<InvitationRow[]> {
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.threadId, threadId))
    .orderBy(desc(invitations.sequence), desc(invitations.dtstamp));

  const latestByUid = new Map<string, InvitationRow>();
  for (const row of rows) {
    if (!latestByUid.has(row.uid)) latestByUid.set(row.uid, row);
  }
  return [...latestByUid.values()];
}

/**
 * Folds one Invitation revision together with whatever live state a
 * matching Series (on one of this User's own Calendars) can add — the
 * whole point of the card being "where the Event is on one of the User's
 * Calendars, the card reflects that Event's live state" (this ticket's
 * acceptance line). No match at all (the mirror hasn't shown the Event yet,
 * or never will) still returns a card: `match: null`, current-revision
 * fields only — the Local fallback (#241) is what eventually fills that
 * gap for a non-synced address.
 */
async function toInvitationCard(
  db: Db,
  userId: string,
  row: InvitationRow,
): Promise<InvitationCard> {
  const [message] = await db
    .select({ fromAddress: messages.fromAddress, recipientAlias: messages.recipientAlias })
    .from(messages)
    .where(eq(messages.id, row.messageId));

  const [mailAccount] = await db
    .select({ emailAddress: mailAccounts.emailAddress })
    .from(mailAccounts)
    .where(eq(mailAccounts.id, row.mailAccountId));
  const selfEmail = mailAccount?.emailAddress ?? null;
  const selfAddresses = [selfEmail, message?.recipientAlias ?? null];

  const match = await findMatch(db, userId, row, selfAddresses);
  // "Addressed to nobody the User is" (ADR-0027): `match` stays `null`
  // because `findMatch` never auto-creates a fallback Series for an
  // Invitation naming no Attendee of the User's own — the card offers "Add
  // to calendar" instead, a private copy nothing here answers as.
  const offerAddToCalendar =
    match === null && row.kind === "request" && !findSelfAttendee(row, selfAddresses);

  return {
    uid: row.uid,
    kind: row.kind,
    sequence: row.sequence,
    dtstamp: row.dtstamp.toISOString(),
    organizer: row.organizer,
    attendees: row.attendees,
    vevent: row.vevent,
    fromAddress: message?.fromAddress ?? null,
    match,
    offerAddToCalendar,
  };
}

async function findMatch(
  db: Db,
  userId: string,
  invitationRow: InvitationRow,
  selfAddresses: readonly (string | null)[],
): Promise<InvitationMatch | null> {
  let [seriesRow] = await db
    .select()
    .from(series)
    .where(and(eq(series.uid, invitationRow.uid), eq(series.userId, userId)))
    .limit(1);

  if (!seriesRow && invitationRow.kind === "request") {
    seriesRow =
      (await ensureLocalFallbackSeries(db, userId, invitationRow, selfAddresses)) ?? undefined;
  }
  if (!seriesRow) return null;

  const [calendarRow] = await db
    .select({ originType: calendars.originType })
    .from(calendars)
    .where(eq(calendars.id, seriesRow.calendarId));

  const [cancelledOccurrence] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.seriesId, seriesRow.id), eq(events.status, "cancelled")))
    .limit(1);

  const normalizedSelf = selfAddresses
    .filter((address): address is string => Boolean(address))
    .map(normalizeAddress);
  const myAttendee = seriesRow.attendees.find((attendee) =>
    normalizedSelf.includes(normalizeAddress(attendee.email)),
  );

  return {
    calendarId: seriesRow.calendarId,
    seriesId: seriesRow.id,
    synced: calendarRow?.originType === "connectedAccount",
    cancelled: seriesRow.deletedAt !== null || Boolean(cancelledOccurrence),
    selfEmail: selfAddresses[0] ?? null,
    myResponseStatus: myAttendee?.responseStatus ?? null,
    isAttendee: myAttendee !== undefined,
  };
}

/** Every invite card a Thread's own opened Reader pane shows (`routes/invitations.ts`), newest revision per `UID` only. */
export async function buildInvitationCards(
  db: Db,
  userId: string,
  threadId: string,
): Promise<InvitationCard[]> {
  const revisions = await latestInvitationRevisionsForThread(db, threadId);
  return Promise.all(revisions.map((row) => toInvitationCard(db, userId, row)));
}
