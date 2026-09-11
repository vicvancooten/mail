import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { calendars, events, users } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import type { CaldavAuth, CaldavCalendarClient, CaldavObject, CaldavSyncResult } from "./client.js";
import { buildCaldavEventBody } from "./event-body.js";
import { syncCaldavCalendarEvents } from "./event-sync.js";

let db: Db;
let closeDb: () => Promise<void>;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

async function createTestUser(): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    username: `user-${id.slice(0, 8)}`,
    passwordHash: "not-a-real-hash",
    role: "owner",
  });
  return id;
}

const CALENDAR_HREF = "https://dav.example.com/calendars/user/work/";
const auth: CaldavAuth = { username: "u", password: "p" };

async function createMirroredCalendar(
  userId: string,
  opts: { davSyncToken?: string | null; davCtag?: string | null } = {},
): Promise<string> {
  const id = `caldav:acct-1:${CALENDAR_HREF}`;
  await db.insert(calendars).values({
    id,
    userId,
    name: "Work",
    timeZone: "UTC",
    originType: "connectedAccount",
    connectedAccountId: "acct-1",
    color: "#4285F4",
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
    davSyncToken: opts.davSyncToken ?? null,
    davCtag: opts.davCtag ?? null,
  });
  return id;
}

function objectFor(href: string, uid: string, summary: string): CaldavObject {
  return {
    href,
    etag: "etag-1",
    scheduleTag: null,
    icsData: buildCaldavEventBody(uid, {
      title: summary,
      description: null,
      location: null,
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-03-02T09:00:00.000Z"),
      durationMs: 30 * 60 * 1000,
      rrules: [],
      rdates: [],
      exdates: [],
      transparency: "opaque",
      attendees: [],
      sequence: 0,
    }),
  };
}

function fakeClient(opts: {
  ctag?: string | null;
  syncResults: CaldavSyncResult[];
  objectsByHref?: Record<string, CaldavObject>;
}): CaldavCalendarClient {
  let call = 0;
  return {
    async listCalendars() {
      throw new Error("not exercised by this test");
    },
    async getCtag() {
      return opts.ctag ?? null;
    },
    async syncCollection() {
      const result = opts.syncResults[call];
      call += 1;
      if (!result) throw new Error("syncCollection called more times than expected");
      return result;
    },
    async multiget(_auth, _calendarUrl, hrefs) {
      return hrefs.map((href) => opts.objectsByHref?.[href]).filter((o): o is CaldavObject => !!o);
    },
    async putObject() {
      throw new Error("not exercised by this test");
    },
  };
}

describe("syncCaldavCalendarEvents", () => {
  it("skips the sync-collection REPORT entirely when getctag is unchanged", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, {
      davSyncToken: "token-1",
      davCtag: "ctag-1",
    });
    const client = fakeClient({ ctag: "ctag-1", syncResults: [] });

    await syncCaldavCalendarEvents({
      db,
      userId,
      calendarId,
      calendarHref: CALENDAR_HREF,
      client,
      auth,
    });

    expect(await db.select().from(events)).toHaveLength(0);
  });

  it("multigets and upserts every changed href, then persists the new sync token and ctag", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, {
      davSyncToken: "token-1",
      davCtag: "old",
    });
    const href = `${CALENDAR_HREF}event-1.ics`;
    const client = fakeClient({
      ctag: "new-ctag",
      syncResults: [
        { kind: "ok", changed: [{ href, etag: "e1" }], deletedHrefs: [], syncToken: "token-2" },
      ],
      objectsByHref: { [href]: objectFor(href, "uid-1", "Standup") },
    });

    await syncCaldavCalendarEvents({
      db,
      userId,
      calendarId,
      calendarHref: CALENDAR_HREF,
      client,
      auth,
    });

    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Standup");
    expect(rows[0]?.upstreamEventId).toBe(href);

    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    expect(calendarRow?.davSyncToken).toBe("token-2");
    expect(calendarRow?.davCtag).toBe("new-ctag");
  });

  it("status-flips (never hard-deletes) an Occurrence whose href a sync-collection REPORT names as deleted", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, { davSyncToken: "token-1" });
    const href = `${CALENDAR_HREF}event-1.ics`;
    await db.insert(events).values({
      id: "uid-1@2026-03-02T09:00:00.000Z",
      userId,
      calendarId,
      seriesId: "uid-1",
      upstreamEventId: href,
      originalStart: new Date("2026-03-02T09:00:00.000Z"),
      startAt: new Date("2026-03-02T09:00:00.000Z"),
      endAt: new Date("2026-03-02T09:30:00.000Z"),
      title: "Standup",
    });
    const client = fakeClient({
      ctag: "ctag-2",
      syncResults: [{ kind: "ok", changed: [], deletedHrefs: [href], syncToken: "token-2" }],
    });

    await syncCaldavCalendarEvents({
      db,
      userId,
      calendarId,
      calendarHref: CALENDAR_HREF,
      client,
      auth,
    });

    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("cancelled");
  });

  it("on a stale sync-token, clears it and re-walks the whole collection fresh, upserting into the same rows", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, { davSyncToken: "stale-token" });
    const href = `${CALENDAR_HREF}event-1.ics`;
    const client = fakeClient({
      ctag: "ctag-fresh",
      syncResults: [
        { kind: "staleToken" },
        { kind: "ok", changed: [{ href, etag: "e1" }], deletedHrefs: [], syncToken: "token-fresh" },
      ],
      objectsByHref: { [href]: objectFor(href, "uid-1", "Re-walked") },
    });

    await syncCaldavCalendarEvents({
      db,
      userId,
      calendarId,
      calendarHref: CALENDAR_HREF,
      client,
      auth,
    });

    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Re-walked");
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    expect(calendarRow?.davSyncToken).toBe("token-fresh");
  });
});
