import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { calendars, events, users } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import {
  type GraphCalendarClient,
  type GraphDeltaEntry,
  GraphDeltaExpiredError,
} from "./client.js";
import { syncGraphCalendarEvents } from "./event-sync.js";

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
  graphDeltaLink: string | null = null,
): Promise<string> {
  const id = "gcal-ms:acct-1:primary";
  await db.insert(calendars).values({
    id,
    userId,
    name: "Work",
    timeZone: "UTC",
    originType: "connectedAccount",
    connectedAccountId: "acct-1",
    color: "#4285F4",
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
    graphDeltaLink,
  });
  return id;
}

function fakeClient(pages: (GraphDeltaEntry[] | "expired")[]): GraphCalendarClient {
  let call = 0;
  return {
    async listCalendars() {
      throw new Error("not exercised by this test");
    },
    async getMailboxTimeZone() {
      throw new Error("not exercised by this test");
    },
    async listCalendarViewDeltaPage() {
      const page = pages[call];
      call += 1;
      if (page === "expired" || page === undefined) throw new GraphDeltaExpiredError();
      return { items: page, deltaLink: "https://graph.microsoft.com/v1.0/delta-link-2" };
    },
    async insertEvent() {
      throw new Error("not exercised by this test");
    },
    async getEvent() {
      throw new Error("not exercised by this test");
    },
    async patchEvent() {
      throw new Error("not exercised by this test");
    },
    async cancelEvent() {
      throw new Error("not exercised by this test");
    },
    async respondToEvent() {
      throw new Error("not exercised by this test");
    },
    async patchCalendar() {
      throw new Error("not exercised by this test");
    },
  };
}

const SINGLETON: GraphDeltaEntry = {
  id: "evt-1",
  changeKey: "ck-1",
  subject: "Standup",
  start: { dateTime: "2026-01-01T09:00:00", timeZone: "UTC" },
  end: { dateTime: "2026-01-01T09:30:00", timeZone: "UTC" },
};

describe("syncGraphCalendarEvents", () => {
  it("does an initial bounded list and persists the round's own deltaLink", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId);
    const client = fakeClient([[SINGLETON]]);

    await syncGraphCalendarEvents({
      db,
      userId,
      calendarId,
      graphCalendarId: "primary",
      client,
      accessToken: "t",
    });

    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Standup");
    expect(rows[0]?.status).toBe("confirmed");
    expect(rows[0]?.upstreamEventId).toBe("evt-1");

    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    expect(calendarRow?.graphDeltaLink).toBe("https://graph.microsoft.com/v1.0/delta-link-2");
  });

  it("marks an isCancelled item as cancelled rather than dropping the row", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId);
    const client = fakeClient([[{ ...SINGLETON, isCancelled: true }]]);

    await syncGraphCalendarEvents({
      db,
      userId,
      calendarId,
      graphCalendarId: "primary",
      client,
      accessToken: "t",
    });

    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows[0]?.status).toBe("cancelled");
  });

  it("resolves a @removed entry against upstreamEventId, marking the row cancelled", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, "https://graph/delta-link-1");
    const client = fakeClient([[{ id: "evt-1", "@removed": { reason: "deleted" } }]]);

    await db.insert(events).values({
      id: "evt-1@2026-01-01T09:00:00.000Z",
      userId,
      calendarId,
      seriesId: "evt-1",
      upstreamEventId: "evt-1",
      originalStart: new Date("2026-01-01T09:00:00Z"),
      startAt: new Date("2026-01-01T09:00:00Z"),
      endAt: new Date("2026-01-01T09:30:00Z"),
      title: "Standup",
      status: "confirmed",
    });

    await syncGraphCalendarEvents({
      db,
      userId,
      calendarId,
      graphCalendarId: "primary",
      client,
      accessToken: "t",
    });

    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("cancelled");
  });

  it("re-lists the whole Event Window fresh on a 410, clearing the stale deltaLink", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, "https://graph/stale-delta-link");
    const client = fakeClient(["expired", [SINGLETON]]);

    await syncGraphCalendarEvents({
      db,
      userId,
      calendarId,
      graphCalendarId: "primary",
      client,
      accessToken: "t",
    });

    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows).toHaveLength(1);
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    expect(calendarRow?.graphDeltaLink).toBe("https://graph.microsoft.com/v1.0/delta-link-2");
  });

  it("walks nextLink across multiple pages before persisting the final deltaLink", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId);
    let call = 0;
    const client: GraphCalendarClient = {
      async listCalendars() {
        throw new Error("not exercised");
      },
      async getMailboxTimeZone() {
        throw new Error("not exercised");
      },
      async listCalendarViewDeltaPage() {
        call += 1;
        if (call === 1) {
          return { items: [SINGLETON], nextLink: "https://graph/next-page" };
        }
        return {
          items: [{ ...SINGLETON, id: "evt-2", changeKey: "ck-2" }],
          deltaLink: "https://graph/final-delta-link",
        };
      },
      async insertEvent() {
        throw new Error("not exercised");
      },
      async getEvent() {
        throw new Error("not exercised");
      },
      async patchEvent() {
        throw new Error("not exercised");
      },
      async cancelEvent() {
        throw new Error("not exercised");
      },
      async respondToEvent() {
        throw new Error("not exercised");
      },
      async patchCalendar() {
        throw new Error("not exercised");
      },
    };

    await syncGraphCalendarEvents({
      db,
      userId,
      calendarId,
      graphCalendarId: "primary",
      client,
      accessToken: "t",
    });

    expect(call).toBe(2);
    const rows = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(rows).toHaveLength(2);
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    expect(calendarRow?.graphDeltaLink).toBe("https://graph/final-delta-link");
  });
});
