import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { calendars } from "../../db/schema.js";
import { recordTombstones } from "../../sync/tombstones.js";
import type { GraphCalendarClient } from "./client.js";
import { foldGraphCalendar, graphCalendarRowId } from "./fold.js";

export interface SyncGraphCalendarListParams {
  db: Db;
  userId: string;
  connectedAccountId: string;
  client: GraphCalendarClient;
  accessToken: string;
}

/**
 * The 15-minute enumeration (#248, `google/calendar-list-sync.ts`'s own
 * shape and cadence): a plain `GET /me/calendars` diffed on `changeKey`
 * (this ticket's own acceptance line) — there is no delta-tracked list for
 * the calendar collection itself (`calendar: delta` lives only in beta,
 * this ticket's own body: "the calendar list has no change-notification
 * subscription and its delta exists only in beta"), so this simply re-lists
 * every 15 minutes and skips a row whose `changeKey` hasn't moved, rather
 * than Google's own field-by-field comparison.
 *
 * The mailbox-wide time zone (`mailboxSettings.timeZone`, this ticket's own
 * acceptance line) is fetched once per tick and applied to every one of this
 * account's Calendar rows uniformly — Graph's `calendar` resource carries no
 * per-calendar `timeZone` of its own (unlike Google's own `Calendars.get`).
 *
 * A vanished row's two-miss tombstone and the free-busy-only skip
 * (`accessRole === "freeBusyReader"` on Google) both reuse `google/calendar-
 * list-sync.ts`'s own reasoning — Graph has no free-busy-only access level
 * to skip (every entry `GET /me/calendars` returns is at least readable),
 * so every entry seen is folded into a row.
 */
export async function syncGraphCalendarList(params: SyncGraphCalendarListParams): Promise<void> {
  const { db, userId, connectedAccountId, client, accessToken } = params;

  const [entries, timeZone] = await Promise.all([
    client.listCalendars(accessToken),
    client.getMailboxTimeZone(accessToken),
  ]);
  const seenIds = new Set<string>();

  for (const entry of entries) {
    const id = graphCalendarRowId(connectedAccountId, entry.id);
    seenIds.add(id);

    const [existing] = await db.select().from(calendars).where(eq(calendars.id, id)).limit(1);
    if (!existing) {
      const folded = foldGraphCalendar(entry);
      await db.insert(calendars).values({
        id,
        userId,
        name: folded.name,
        description: null,
        timeZone,
        originType: "connectedAccount",
        connectedAccountId,
        color: folded.color,
        isDefault: false,
        mailAccountId: null,
        mirrored: folded.capabilities.writable,
        capabilities: folded.capabilities,
        missingConfirmations: 0,
        graphChangeKey: entry.changeKey,
        remindersEnabled: true,
        // Left at the schema default (`{timed: [], allDay: []}`) — Graph has
        // no calendar-level default of its own to seed from (#244, ADR-0028:
        // "Graph has no calendar-level default at all").
      });
      continue;
    }

    if (existing.missingConfirmations !== 0) {
      await db.update(calendars).set({ missingConfirmations: 0 }).where(eq(calendars.id, id));
    }

    // Diffed on `changeKey` alone (this ticket's own acceptance line) —
    // unchanged means nothing about this row's name/colour/`canEdit`/time
    // zone needs re-folding, no field comparison required.
    if (existing.graphChangeKey === entry.changeKey && existing.timeZone === timeZone) {
      continue;
    }
    const folded = foldGraphCalendar(entry);
    await db
      .update(calendars)
      .set({
        name: folded.name,
        timeZone,
        color: folded.color,
        capabilities: folded.capabilities,
        graphChangeKey: entry.changeKey,
        updatedAt: new Date(),
      })
      .where(eq(calendars.id, id));
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
  // Google and Graph mirrored rows share one `connectedAccountId` namespace
  // only in principle — in practice a Connected Account has exactly one
  // provider, so a `gcal:`-prefixed (Google) row never turns up here for a
  // Microsoft account's own tick; `graphCalendarRowId`'s own `gcal-ms:`
  // prefix keeps the two unambiguous regardless.
  const existingGraphRows = existingForAccount.filter((row) => row.id.startsWith("gcal-ms:"));

  const stillMissing = existingGraphRows.filter((row) => !seenIds.has(row.id));
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
