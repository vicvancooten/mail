import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { calendars, syncTombstones, users } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import { syncGraphCalendarList } from "./calendar-list-sync.js";
import type { GraphCalendarClient, GraphCalendarListEntry } from "./client.js";
import { graphCalendarRowId } from "./fold.js";

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
  entries: GraphCalendarListEntry[],
  timeZone = "Europe/Amsterdam",
): GraphCalendarClient {
  return {
    async listCalendars() {
      return entries;
    },
    async getMailboxTimeZone() {
      return timeZone;
    },
    async listCalendarViewDeltaPage() {
      throw new Error("not exercised by this test");
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

describe("syncGraphCalendarList", () => {
  it("inserts a new mirrored Calendar row per GET /me/calendars entry, folded with the mailbox time zone", async () => {
    const userId = await createTestUser();
    const client = fakeClient([
      { id: "AAMk-primary", name: "Calendar", canEdit: true, changeKey: "ck-1" },
    ]);

    await syncGraphCalendarList({
      db,
      userId,
      connectedAccountId: "acct-1",
      client,
      accessToken: "t",
    });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(graphCalendarRowId("acct-1", "AAMk-primary"));
    expect(rows[0]?.name).toBe("Calendar");
    expect(rows[0]?.timeZone).toBe("Europe/Amsterdam");
    expect(rows[0]?.mirrored).toBe(true);
    expect(rows[0]?.graphChangeKey).toBe("ck-1");
  });

  it("updates an existing row only when changeKey has moved", async () => {
    const userId = await createTestUser();
    const params = { db, userId, connectedAccountId: "acct-1", accessToken: "t" };

    await syncGraphCalendarList({
      ...params,
      client: fakeClient([{ id: "AAMk-primary", name: "Work", canEdit: true, changeKey: "ck-1" }]),
    });
    // Same changeKey, a different (stale/incorrect) name in this round's
    // payload — must be ignored, since the row is diffed on changeKey alone.
    await syncGraphCalendarList({
      ...params,
      client: fakeClient([
        { id: "AAMk-primary", name: "Ignored", canEdit: true, changeKey: "ck-1" },
      ]),
    });

    let rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows[0]?.name).toBe("Work");

    await syncGraphCalendarList({
      ...params,
      client: fakeClient([
        { id: "AAMk-primary", name: "Renamed", canEdit: true, changeKey: "ck-2" },
      ]),
    });
    rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Renamed");
    expect(rows[0]?.graphChangeKey).toBe("ck-2");
  });

  it("defaults mirrored off for a read-only (canEdit: false) calendar", async () => {
    const userId = await createTestUser();
    const client = fakeClient([
      { id: "holidays", name: "Holidays", canEdit: false, changeKey: "ck-1" },
    ]);

    await syncGraphCalendarList({
      db,
      userId,
      connectedAccountId: "acct-1",
      client,
      accessToken: "t",
    });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows[0]?.mirrored).toBe(false);
    expect(rows[0]?.capabilities.recurrenceGrammar).toBe("none");
  });

  it("does not tombstone a Calendar missing from only one enumeration", async () => {
    const userId = await createTestUser();
    const params = { db, userId, connectedAccountId: "acct-1", accessToken: "t" };
    await syncGraphCalendarList({
      ...params,
      client: fakeClient([{ id: "primary", name: "Work", canEdit: true, changeKey: "ck-1" }]),
    });
    await syncGraphCalendarList({ ...params, client: fakeClient([]) });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.missingConfirmations).toBe(1);
    expect(await db.select().from(syncTombstones)).toHaveLength(0);
  });

  it("tombstones a Calendar missing from two consecutive enumerations, never immediately", async () => {
    const userId = await createTestUser();
    const params = { db, userId, connectedAccountId: "acct-1", accessToken: "t" };
    const seen = fakeClient([{ id: "primary", name: "Work", canEdit: true, changeKey: "ck-1" }]);
    const vanished = fakeClient([]);

    await syncGraphCalendarList({ ...params, client: seen });
    await syncGraphCalendarList({ ...params, client: vanished });
    await syncGraphCalendarList({ ...params, client: vanished });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(0);
    const tombstones = await db.select().from(syncTombstones);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.collection).toBe("Calendar");
    expect(tombstones[0]?.entityId).toBe(graphCalendarRowId("acct-1", "primary"));
  });

  it("resets missingConfirmations to 0 once a previously-missing Calendar reappears", async () => {
    const userId = await createTestUser();
    const params = { db, userId, connectedAccountId: "acct-1", accessToken: "t" };
    const seen = fakeClient([{ id: "primary", name: "Work", canEdit: true, changeKey: "ck-1" }]);
    const vanished = fakeClient([]);

    await syncGraphCalendarList({ ...params, client: seen });
    await syncGraphCalendarList({ ...params, client: vanished });
    await syncGraphCalendarList({ ...params, client: seen });

    const rows = await db.select().from(calendars).where(eq(calendars.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.missingConfirmations).toBe(0);
  });
});
