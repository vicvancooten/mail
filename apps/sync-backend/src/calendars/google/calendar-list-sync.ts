import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { calendars } from "../../db/schema.js";
import { recordTombstones } from "../../sync/tombstones.js";
import type { GoogleCalendarClient } from "./client.js";
import { foldGoogleCalendar, googleCalendarRowId } from "./fold.js";

export interface SyncGoogleCalendarListParams {
  db: Db;
  userId: string;
  connectedAccountId: string;
  client: GoogleCalendarClient;
  accessToken: string;
}

/**
 * The 15-minute enumeration (#234's own acceptance line): "`CalendarList`
 * and `Calendars` folding into one Calendar row" for every Google calendar
 * this Connected Account can currently see, upserted into the mirrored
 * `calendars` rows this account already owns.
 *
 * A row that Google no longer lists is **not** deleted on the first miss —
 * "a vanished Calendar is tombstoned only after a second confirmation"
 * guards against a single flaky `calendarList.list` response (rate limit,
 * transient 5xx swallowed upstream, a momentary access-role hiccup) reading
 * as a real removal. `missingConfirmations` persists that count across
 * separate 15-minute ticks; it resets to `0` the instant a row is seen
 * again.
 *
 * A `freeBusyReader` entry is never folded into a row at all (#235's own
 * acceptance line: "free-busy-only calendars are dropped entirely rather
 * than listed unmirrored — there is nothing to show, so a row would be a
 * permanently empty offer"). It is simply left out of `seenIds`, so a
 * calendar that *was* mirrored before Google downgraded its `accessRole` to
 * free-busy-only falls into the same two-miss tombstone path as one that
 * vanished outright — no separate code path needed.
 */
export async function syncGoogleCalendarList(params: SyncGoogleCalendarListParams): Promise<void> {
  const { db, userId, connectedAccountId, client, accessToken } = params;

  const entries = await client.listCalendarList(accessToken);
  const seenIds = new Set<string>();

  for (const entry of entries) {
    if (entry.accessRole === "freeBusyReader") continue;

    const id = googleCalendarRowId(connectedAccountId, entry.id);
    seenIds.add(id);
    const metadata = await client.getCalendar(accessToken, entry.id);
    const folded = foldGoogleCalendar(entry, metadata);

    const [existing] = await db.select().from(calendars).where(eq(calendars.id, id)).limit(1);
    if (!existing) {
      await db.insert(calendars).values({
        id,
        userId,
        name: folded.name,
        description: metadata.description ?? null,
        timeZone: folded.timeZone,
        originType: "connectedAccount",
        connectedAccountId,
        color: folded.color,
        isDefault: false,
        mailAccountId: null,
        // #235's own acceptance line: "`mirrored` defaults on for what the
        // User owns or can write, off for read-only subscriptions" — exactly
        // `capabilitiesFromAccessRole`'s own `writable` flag, so there is one
        // place accessRole is translated into a boolean, not two.
        mirrored: folded.capabilities.writable,
        capabilities: folded.capabilities,
        missingConfirmations: 0,
        remindersEnabled: true,
        // Seeded once, right here, and never touched by the `changed`
        // update branch below (#244, ADR-0028's own "seeded once" line).
        reminderDefault: folded.reminderDefault,
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
