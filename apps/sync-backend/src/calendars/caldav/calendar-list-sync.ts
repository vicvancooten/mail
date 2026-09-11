import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { calendars, mailAccounts } from "../../db/schema.js";
import { recordTombstones } from "../../sync/tombstones.js";
import type { CaldavAuth, CaldavCalendarClient } from "./client.js";
import { caldavCalendarRowId, foldCaldavCalendar } from "./fold.js";

export interface SyncCaldavCalendarListParams {
  db: Db;
  userId: string;
  connectedAccountId: string;
  homeSetUrl: string;
  client: CaldavCalendarClient;
  auth: CaldavAuth;
}

/** This User's oldest Mail Account — `calendars/store.ts#ensurePersonalCalendar`'s own query, reused here for the same reason: a self-scheduled Calendar's organiser identity (#242) needs a Mail Account to send from. */
async function oldestMailAccountId(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(eq(mailAccounts.userId, userId))
    .orderBy(asc(mailAccounts.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The 15-minute enumeration (#247, `google/calendar-list-sync.ts`'s own
 * shape): a Depth-1 PROPFIND of the Facet's own home-set (#203's discovery
 * output), diffed and upserted into the mirrored `calendars` rows this
 * Connected Account already owns.
 *
 * A CalDAV Calendar without `calendar-auto-schedule` is self-scheduled
 * (this ticket's own acceptance line): `mailAccountId` is seeded, once, from
 * the User's oldest Mail Account — `calendars/store.ts#ensurePersonalCalendar`'s
 * own "seeded once at creation" convention — so `series-store.ts
 * #resolveOrganizerIdentity` and the Local organiser/`REPLY` paths (#242)
 * pick this Calendar up with **no code of their own added**: both already
 * key off `capabilities.invitesSentByUpstream`/`mailAccountId` alone.
 *
 * The two-miss tombstone (`missingConfirmations`) and the "upsert on every
 * unchanged tick costs one comparison, not one write" shape are
 * `google/calendar-list-sync.ts`'s own, reused verbatim.
 */
export async function syncCaldavCalendarList(params: SyncCaldavCalendarListParams): Promise<void> {
  const { db, userId, connectedAccountId, homeSetUrl, client, auth } = params;

  const entries = await client.listCalendars(auth, homeSetUrl);
  const seenIds = new Set<string>();

  for (const entry of entries) {
    const id = caldavCalendarRowId(connectedAccountId, entry.href);
    seenIds.add(id);
    const folded = foldCaldavCalendar(entry);

    const [existing] = await db.select().from(calendars).where(eq(calendars.id, id)).limit(1);
    if (!existing) {
      const mailAccountIdForRow = folded.capabilities.invitesSentByUpstream
        ? null
        : await oldestMailAccountId(db, userId);
      await db.insert(calendars).values({
        id,
        userId,
        name: folded.name,
        description: null,
        timeZone: folded.timeZone,
        originType: "connectedAccount",
        connectedAccountId,
        color: folded.color,
        isDefault: false,
        mailAccountId: mailAccountIdForRow,
        // #235's own acceptance line: "`mirrored` defaults on for what the
        // User owns or can write, off for read-only subscriptions" — same
        // "one place `writable` is translated into a boolean" reasoning
        // `google/calendar-list-sync.ts` already gives.
        mirrored: folded.capabilities.writable,
        capabilities: folded.capabilities,
        missingConfirmations: 0,
        remindersEnabled: true,
        davCtag: entry.ctag,
      });
      continue;
    }

    if (existing.missingConfirmations !== 0) {
      await db.update(calendars).set({ missingConfirmations: 0 }).where(eq(calendars.id, id));
    }
    const changed =
      existing.name !== folded.name ||
      existing.timeZone !== folded.timeZone ||
      existing.color !== folded.color ||
      JSON.stringify(existing.capabilities) !== JSON.stringify(folded.capabilities);
    if (changed) {
      await db
        .update(calendars)
        .set({
          name: folded.name,
          timeZone: folded.timeZone,
          color: folded.color,
          capabilities: folded.capabilities,
          updatedAt: new Date(),
        })
        .where(eq(calendars.id, id));
    }
  }

  const existingForAccount = await db
    .select()
    .from(calendars)
    .where(
      and(
        eq(calendars.originType, "connectedAccount"),
        eq(calendars.connectedAccountId, connectedAccountId),
      ),
    );

  const stillMissing = existingForAccount.filter((row) => !seenIds.has(row.id));
  const toTombstone = stillMissing
    .filter((row) => row.missingConfirmations >= 1)
    .map((row) => row.id);
  const toMarkOnceMissing = stillMissing
    .filter((row) => row.missingConfirmations === 0)
    .map((row) => row.id);

  for (const id of toMarkOnceMissing) {
    await db.update(calendars).set({ missingConfirmations: 1 }).where(eq(calendars.id, id));
  }
  if (toTombstone.length > 0) {
    await db.delete(calendars).where(inArray(calendars.id, toTombstone));
    await recordTombstones(db, {
      mailAccountId: null,
      collection: "Calendar",
      entityIds: toTombstone,
    });
  }
}
