import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { calendars, events, users } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import {
  type GoogleCalendarClient,
  type GoogleEvent,
  GoogleSyncTokenExpiredError,
} from "./client.js";
import { syncGoogleCalendarEvents } from "./event-sync.js";

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

async function createMirroredCalendar(
  userId: string,
  googleSyncToken: string | null = null,
): Promise<string> {
  const id = `gcal:acct-1:primary`;
  await db.insert(calendars).values({
    id,
    userId,
    name: "Work",
    timeZone: "UTC",
    originType: "connectedAccount",
    connectedAccountId: "acct-1",
    color: "#4285F4",
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
    googleSyncToken,
  });
  return id;
}

function fakeClient(pages: (GoogleEvent[] | "expired")[]): GoogleCalendarClient {
  let call = 0;
  return {
    async listCalendarList() {
      throw new Error("not exercised by this test");
    },
    async getCalendar() {
      throw new Error("not exercised by this test");
    },
    async listEventsPage() {
      const page = pages[call];
      call += 1;
      if (page === "expired" || page === undefined) throw new GoogleSyncTokenExpiredError();
      return { items: page, nextSyncToken: "new-token" };
    },
    async insertEvent() {
      throw new Error("not exercised by this test");
    },
    async patchEvent() {
      throw new Error("not exercised by this test");
    },
  };
}

const SINGLETON: GoogleEvent = {
  id: "evt-1",
  status: "confirmed",
  summary: "Standup",
  start: { dateTime: "2026-01-01T09:00:00Z" },
  end: { dateTime: "2026-01-01T09:30:00Z" },
};

describe("syncGoogleCalendarEvents", () => {
  it("upserts a singleton event and stores the returned syncToken", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId);
    const client = fakeClient([[SINGLETON]]);

    await syncGoogleCalendarEvents({
      db,
      userId,
      calendarId,
      googleCalendarId: "primary",
      client,
      accessToken: "token",
    });

    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("evt-1@2026-01-01T09:00:00.000Z");
    expect(rows[0]?.seriesId).toBe("evt-1");
    expect(rows[0]?.title).toBe("Standup");
    expect(rows[0]?.status).toBe("confirmed");
    expect(rows[0]?.allDay).toBe(false);

    const [row] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    expect(row?.googleSyncToken).toBe("new-token");
  });

  it("maps a cancelled Google event to status cancelled, never deleting the row", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, "old-token");
    const cancelled: GoogleEvent = { ...SINGLETON, status: "cancelled" };
    const client = fakeClient([[cancelled]]);

    await syncGoogleCalendarEvents({
      db,
      userId,
      calendarId,
      googleCalendarId: "primary",
      client,
      accessToken: "token",
    });

    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("cancelled");
  });

  it("treats an all-day event (date, not dateTime) as allDay", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId);
    const allDayEvent: GoogleEvent = {
      id: "evt-2",
      status: "confirmed",
      summary: "Holiday",
      start: { date: "2026-01-05" },
      end: { date: "2026-01-06" },
    };
    const client = fakeClient([[allDayEvent]]);

    await syncGoogleCalendarEvents({
      db,
      userId,
      calendarId,
      googleCalendarId: "primary",
      client,
      accessToken: "token",
    });

    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows[0]?.allDay).toBe(true);
  });

  it("on a 410, clears the stored syncToken and re-lists without ever touching the Client-visible reset flag", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, "expired-token");
    let call = 0;
    const client: GoogleCalendarClient = {
      async listCalendarList() {
        throw new Error("not exercised");
      },
      async getCalendar() {
        throw new Error("not exercised");
      },
      async listEventsPage(_token, _calId, params) {
        call += 1;
        if (call === 1) {
          expect(params.syncToken).toBe("expired-token");
          throw new GoogleSyncTokenExpiredError();
        }
        // The re-list carries no syncToken — a full list off the Event Window instead.
        expect(params.syncToken).toBeUndefined();
        expect(params.timeMin).toBeDefined();
        return { items: [SINGLETON], nextSyncToken: "fresh-token" };
      },
      async insertEvent() {
        throw new Error("not exercised");
      },
      async patchEvent() {
        throw new Error("not exercised");
      },
    };

    await syncGoogleCalendarEvents({
      db,
      userId,
      calendarId,
      googleCalendarId: "primary",
      client,
      accessToken: "token",
    });

    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows).toHaveLength(1);
    const [row] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    expect(row?.googleSyncToken).toBe("fresh-token");
  });

  it("walks every page before persisting the final page's syncToken", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId);
    let call = 0;
    const client: GoogleCalendarClient = {
      async listCalendarList() {
        throw new Error("not exercised");
      },
      async getCalendar() {
        throw new Error("not exercised");
      },
      async listEventsPage() {
        call += 1;
        if (call === 1) {
          return { items: [SINGLETON], nextPageToken: "page-2" };
        }
        return { items: [{ ...SINGLETON, id: "evt-2" }], nextSyncToken: "final-token" };
      },
      async insertEvent() {
        throw new Error("not exercised");
      },
      async patchEvent() {
        throw new Error("not exercised");
      },
    };

    await syncGoogleCalendarEvents({
      db,
      userId,
      calendarId,
      googleCalendarId: "primary",
      client,
      accessToken: "token",
    });

    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows).toHaveLength(2);
    const [row] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    expect(row?.googleSyncToken).toBe("final-token");
  });
});
