import { randomUUID } from "node:crypto";
import { personalCalendarId } from "@mail/shared";
import { and, asc, eq } from "drizzle-orm";
import { computeMaterialisationWindow } from "../calendars/materialise-loop.js";
import { rematerialiseSeries } from "../calendars/series-store.js";
import { getConnectedAccountFacet } from "../connected-accounts/store.js";
import type { Db } from "../db/client.js";
import {
  calendars,
  type InvitationRow,
  mailAccounts,
  type SeriesRow,
  series,
} from "../db/schema.js";

/**
 * The Local fallback (#241, ADR-0027): where an Invitation lands when the
 * address it arrived at is not the upstream's to show — Other IMAP, a
 * Google account with only the Mail Facet, or an Alias. `card.ts#findMatch`
 * is the one caller: it creates the fallback Event lazily, the first time
 * the Reader's invite card is built for a Thread carrying this `UID`, rather
 * than at ingest time (`invitations/store.ts` stays untouched by this
 * ticket) — a deliberate scope cut recorded in this ticket's closing
 * comment.
 */

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Whether the Mail Account that received this Invitation has an active Calendar Facet — "synced first" (ADR-0027): the mirror owns it, #241 builds nothing. */
export async function hasActiveCalendarFacet(db: Db, connectedAccountId: string): Promise<boolean> {
  const facet = await getConnectedAccountFacet(db, connectedAccountId, "calendar");
  return facet?.status === "active";
}

/**
 * ADR-0027's landing order: "the default Calendar if it is among the linked
 * ones, else the oldest linked one, else the default Calendar when it is
 * Local, else Personal" — `mailAccountId` names the Mail Account the
 * Invitation arrived at, and "linked" means a Local Calendar whose own
 * `mailAccountId` names that same Mail Account (`setCalendarMailAccount`,
 * #236).
 */
export async function resolveLocalFallbackCalendar(
  db: Db,
  userId: string,
  mailAccountId: string,
): Promise<string> {
  const linked = await db
    .select()
    .from(calendars)
    .where(
      and(
        eq(calendars.userId, userId),
        eq(calendars.mailAccountId, mailAccountId),
        eq(calendars.originType, "local"),
      ),
    )
    .orderBy(asc(calendars.createdAt));
  const defaultLinked = linked.find((calendar) => calendar.isDefault);
  if (defaultLinked) return defaultLinked.id;
  if (linked[0]) return linked[0].id;

  const [globalDefault] = await db
    .select({ id: calendars.id, originType: calendars.originType })
    .from(calendars)
    .where(and(eq(calendars.userId, userId), eq(calendars.isDefault, true)));
  if (globalDefault?.originType === "local") return globalDefault.id;

  return personalCalendarId(userId);
}

/**
 * Whether `address` (any of its known forms — the Mail Account's own
 * address, or the Alias this particular Message arrived at) names an
 * Attendee this Invitation actually lists — "nobody the User is" (ADR-0027)
 * is everyone *else's* case.
 */
export function findSelfAttendee(
  invitation: Pick<InvitationRow, "attendees">,
  selfAddresses: readonly (string | null)[],
): boolean {
  const normalizedSelf = selfAddresses
    .filter((address): address is string => Boolean(address))
    .map(normalizeAddress);
  if (normalizedSelf.length === 0) return false;
  return invitation.attendees.some((attendee) =>
    normalizedSelf.includes(normalizeAddress(attendee.address)),
  );
}

/**
 * Creates this Invitation's fallback Series (#241, ADR-0027: "creates its
 * fallback Event on arrival as 'no answer yet'") the first time anything
 * asks for it — idempotent on `(uid, userId)`, so a second call (a second
 * Reader open, a concurrent request) finds the row `ensureLocalFallbackSeries`
 * already made rather than a duplicate.
 *
 * Returns `null` when this isn't #241's path at all: the Mail Account has an
 * active Calendar Facet (the mirror owns it — "synced first"), or the
 * invited address matches no Attendee this Invitation lists ("addressed to
 * nobody the User is" — the card's own "Add to calendar" offers that path
 * instead, `addInvitationAsPrivateCopy` below).
 */
export async function ensureLocalFallbackSeries(
  db: Db,
  userId: string,
  invitation: InvitationRow,
  selfAddresses: readonly (string | null)[],
): Promise<SeriesRow | null> {
  const [existing] = await db
    .select()
    .from(series)
    .where(and(eq(series.uid, invitation.uid), eq(series.userId, userId)))
    .limit(1);
  if (existing) return existing;

  const [mailAccount] = await db
    .select()
    .from(mailAccounts)
    .where(eq(mailAccounts.id, invitation.mailAccountId));
  if (!mailAccount || mailAccount.userId !== userId) return null;
  if (await hasActiveCalendarFacet(db, mailAccount.connectedAccountId)) return null;
  if (!findSelfAttendee(invitation, selfAddresses)) return null;

  return createFallbackSeries(db, userId, invitation, mailAccount, { asAttendee: true });
}

/**
 * The "Add to calendar" action (ADR-0027): a private copy of an Invitation
 * addressed to nobody the User is — a forwarded invite — on the Local
 * Calendar the invited Mail Account resolves to, with no Attendee entry of
 * the User's own (Wicket never answers as an address the User does not
 * own). Idempotent: a second click on an already-added Invitation is a
 * harmless no-op.
 */
export async function addInvitationAsPrivateCopy(
  db: Db,
  userId: string,
  invitation: InvitationRow,
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  const [existing] = await db
    .select({ id: series.id })
    .from(series)
    .where(and(eq(series.uid, invitation.uid), eq(series.userId, userId)))
    .limit(1);
  if (existing) return { ok: true };

  const [mailAccount] = await db
    .select()
    .from(mailAccounts)
    .where(eq(mailAccounts.id, invitation.mailAccountId));
  if (!mailAccount || mailAccount.userId !== userId) return { ok: false, reason: "not_found" };

  await createFallbackSeries(db, userId, invitation, mailAccount, { asAttendee: false });
  return { ok: true };
}

async function createFallbackSeries(
  db: Db,
  userId: string,
  invitation: InvitationRow,
  mailAccount: typeof mailAccounts.$inferSelect,
  { asAttendee }: { asAttendee: boolean },
): Promise<SeriesRow> {
  const calendarId = await resolveLocalFallbackCalendar(db, userId, mailAccount.id);
  const vevent = invitation.vevent;
  const start = vevent?.start ? new Date(vevent.start) : new Date();
  const end = vevent?.end ? new Date(vevent.end) : start;
  const now = new Date();
  const newRow: typeof series.$inferInsert = {
    id: randomUUID(),
    userId,
    calendarId,
    uid: invitation.uid,
    sequence: invitation.sequence,
    title: vevent?.title ?? "(no title)",
    description: vevent?.description ?? null,
    location: vevent?.location ?? null,
    allDay: vevent?.allDay ?? false,
    floating: false,
    tzid: vevent?.tzid ?? null,
    dtstart: start,
    durationMs: Math.max(0, end.getTime() - start.getTime()),
    transparency: "opaque",
    attendees: asAttendee
      ? invitation.attendees.map((attendee) => ({
          email: attendee.address,
          name: attendee.name,
          responseStatus: "needsAction" as const,
        }))
      : [],
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(series).values(newRow).onConflictDoNothing({ target: series.id });
  // A concurrent call may have inserted first (same `uid`, different id,
  // no unique constraint on `(uid, userId)` to conflict on) — re-select the
  // canonical row by `uid` rather than trust the id just minted, so two
  // racing card builds converge on one Series either way.
  const [row] = await db
    .select()
    .from(series)
    .where(and(eq(series.uid, invitation.uid), eq(series.userId, userId)))
    .limit(1);
  const canonical = row ?? { ...newRow, createdAt: now, updatedAt: now };

  const window = computeMaterialisationWindow();
  await rematerialiseSeries(db, canonical as SeriesRow, window.start, window.end);
  return canonical as SeriesRow;
}
