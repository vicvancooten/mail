import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { calendars, syncTombstones, users } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import { syncGoogleCalendarList } from "./calendar-list-sync.js";
import type {
  GoogleCalendarClient,
  GoogleCalendarListEntry,
  GoogleCalendarMetadata,
} from "./client.js";
import { googleCalendarRowId } from "./fold.js";

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

function fakeClient(
  entries: GoogleCalendarListEntry[],
  metadataById: Record<string, GoogleCalendarMetadata>,
): GoogleCalendarClient {
  return {
    async listCalendarList() {
      return entries;
    },
    async getCalendar(_token, calendarId) {
      const metadata = metadataById[calendarId];
      if (!metadata) throw new Error(`no metadata fixture for ${calendarId}`);
      return metadata;
    },
    async listEventsPage() {
      throw new Error("not exercised by this test");
    },
    async insertEvent() {
      throw new Error("not exercised by this test");
    },
    async patchEvent() {
      throw new Error("not exercised by this test");
    },
  };
}

describe("syncGoogleCalendarList", () => {
  it("inserts a new mirrored Calendar row per CalendarList entry, folded with its Calendars metadata", async () => {
    const userId = await createTestUser();
    const client = fakeClient([{ id: "primary", accessRole: "owner", summary: "Work" }], {
      primary: { id: "primary", timeZone: "Europe/Amsterdam" },
    });

    await syncGoogleCalendarList({
      db,
      userId,
      connectedAccountId: "acct-1",
      client,
      accessToken: "token",
    });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(googleCalendarRowId("acct-1", "primary"));
    expect(rows[0]?.name).toBe("Work");
    expect(rows[0]?.timeZone).toBe("Europe/Amsterdam");
    expect(rows[0]?.originType).toBe("connectedAccount");
    expect(rows[0]?.connectedAccountId).toBe("acct-1");
    expect(rows[0]?.mirrored).toBe(true);
  });

  it("updates an existing row in place rather than duplicating it on a second sync", async () => {
    const userId = await createTestUser();
    const client = fakeClient([{ id: "primary", accessRole: "owner", summary: "Renamed" }], {
      primary: { id: "primary", timeZone: "Europe/Amsterdam" },
    });
    const params = { db, userId, connectedAccountId: "acct-1", client, accessToken: "token" };

    await syncGoogleCalendarList(params);
    await syncGoogleCalendarList(params);

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Renamed");
  });

  it("does not tombstone a Calendar missing from only one enumeration", async () => {
    const userId = await createTestUser();
    const seenClient = fakeClient([{ id: "primary", accessRole: "owner" }], {
      primary: { id: "primary", timeZone: "UTC" },
    });
    await syncGoogleCalendarList({
      db,
      userId,
      connectedAccountId: "acct-1",
      client: seenClient,
      accessToken: "t",
    });

    const vanishedClient = fakeClient([], {});
    await syncGoogleCalendarList({
      db,
      userId,
      connectedAccountId: "acct-1",
      client: vanishedClient,
      accessToken: "t",
    });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.missingConfirmations).toBe(1);
    const tombstones = await db.select().from(syncTombstones);
    expect(tombstones).toHaveLength(0);
  });

  it("tombstones a Calendar missing from two consecutive enumerations, never immediately", async () => {
    const userId = await createTestUser();
    const seenClient = fakeClient([{ id: "primary", accessRole: "owner" }], {
      primary: { id: "primary", timeZone: "UTC" },
    });
    const vanishedClient = fakeClient([], {});
    const params = { db, userId, connectedAccountId: "acct-1", accessToken: "t" };

    await syncGoogleCalendarList({ ...params, client: seenClient });
    await syncGoogleCalendarList({ ...params, client: vanishedClient });
    await syncGoogleCalendarList({ ...params, client: vanishedClient });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(0);
    const tombstones = await db.select().from(syncTombstones);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.collection).toBe("Calendar");
    expect(tombstones[0]?.entityId).toBe(googleCalendarRowId("acct-1", "primary"));
  });

  it("defaults mirrored off for a read-only subscription (a reader accessRole)", async () => {
    const userId = await createTestUser();
    const client = fakeClient([{ id: "holidays", accessRole: "reader", summary: "Holidays" }], {
      holidays: { id: "holidays", timeZone: "UTC" },
    });

    await syncGoogleCalendarList({
      db,
      userId,
      connectedAccountId: "acct-1",
      client,
      accessToken: "token",
    });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mirrored).toBe(false);
  });

  it("defaults mirrored on for a writer accessRole, same as owner", async () => {
    const userId = await createTestUser();
    const client = fakeClient([{ id: "shared", accessRole: "writer", summary: "Shared" }], {
      shared: { id: "shared", timeZone: "UTC" },
    });

    await syncGoogleCalendarList({
      db,
      userId,
      connectedAccountId: "acct-1",
      client,
      accessToken: "token",
    });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows[0]?.mirrored).toBe(true);
  });

  it("drops a free-busy-only calendar entirely rather than listing it unmirrored", async () => {
    const userId = await createTestUser();
    const client = fakeClient(
      [{ id: "freebusy-only", accessRole: "freeBusyReader", summary: "A colleague" }],
      // No metadata fixture registered — a free-busy entry must never even
      // reach `getCalendar`, or this test's fake throws.
      {},
    );

    await syncGoogleCalendarList({
      db,
      userId,
      connectedAccountId: "acct-1",
      client,
      accessToken: "token",
    });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it("tombstones a mirrored Calendar whose accessRole degrades to free-busy-only", async () => {
    const userId = await createTestUser();
    const writableClient = fakeClient([{ id: "primary", accessRole: "writer" }], {
      primary: { id: "primary", timeZone: "UTC" },
    });
    const degradedClient = fakeClient([{ id: "primary", accessRole: "freeBusyReader" }], {
      primary: { id: "primary", timeZone: "UTC" },
    });
    const params = { db, userId, connectedAccountId: "acct-1", accessToken: "t" };

    await syncGoogleCalendarList({ ...params, client: writableClient });
    await syncGoogleCalendarList({ ...params, client: degradedClient });
    await syncGoogleCalendarList({ ...params, client: degradedClient });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it("resets missingConfirmations to 0 once a previously-missing Calendar reappears", async () => {
    const userId = await createTestUser();
    const seenClient = fakeClient([{ id: "primary", accessRole: "owner" }], {
      primary: { id: "primary", timeZone: "UTC" },
    });
    const vanishedClient = fakeClient([], {});
    const params = { db, userId, connectedAccountId: "acct-1", accessToken: "t" };

    await syncGoogleCalendarList({ ...params, client: seenClient });
    await syncGoogleCalendarList({ ...params, client: vanishedClient });
    await syncGoogleCalendarList({ ...params, client: seenClient });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.missingConfirmations).toBe(0);
  });
});
