import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { calendars, events, syncTombstones, users } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { countMirroredEvents, discardMirroredEvents } from "./mirror-discard.js";

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

async function createCalendar(userId: string): Promise<string> {
  const id = `gcal:acct-1:${randomUUID()}`;
  await db.insert(calendars).values({
    id,
    userId,
    name: "Work",
    description: null,
    timeZone: "UTC",
    originType: "connectedAccount",
    connectedAccountId: "acct-1",
    color: "#4285F4",
    isDefault: false,
    mailAccountId: null,
    mirrored: true,
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
  });
  return id;
}

async function createEvent(userId: string, calendarId: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(events).values({
    id,
    userId,
    calendarId,
    seriesId: id,
    originalStart: now,
    startAt: now,
    endAt: now,
    allDay: false,
    title: "Standup",
    status: "confirmed",
  });
  return id;
}

describe("discardMirroredEvents", () => {
  it("is a no-op for a Calendar with no Occurrences", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);

    const counts = await discardMirroredEvents(db, calendarId);

    expect(counts).toEqual({ events: 0 });
    expect(await db.select().from(syncTombstones)).toHaveLength(0);
  });

  it("deletes and tombstones only the target Calendar's own Occurrences", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const otherCalendarId = await createCalendar(userId);
    await createEvent(userId, calendarId);
    await createEvent(userId, calendarId);
    const untouchedEventId = await createEvent(userId, otherCalendarId);

    const counts = await discardMirroredEvents(db, calendarId);

    expect(counts).toEqual({ events: 2 });
    const remaining = await db.select().from(events);
    expect(remaining.map((row) => row.id)).toEqual([untouchedEventId]);
  });
});

describe("countMirroredEvents", () => {
  it("counts without deleting", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    await createEvent(userId, calendarId);

    const counts = await countMirroredEvents(db, calendarId);

    expect(counts).toEqual({ events: 1 });
    expect(await db.select().from(events).where(eq(events.calendarId, calendarId))).toHaveLength(1);
  });
});
