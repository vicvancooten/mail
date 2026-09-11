import { randomUUID } from "node:crypto";
import {
  LOCAL_ALL_DAY_REMINDER_DEFAULT,
  LOCAL_CALENDAR_CAPABILITIES,
  LOCAL_TIMED_REMINDER_DEFAULT,
} from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { calendars, events, syncTombstones, users } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  CalendarNotFoundError,
  CalendarNotMirrorableError,
  ensurePersonalCalendar,
  mirrorCalendar,
  unmirrorCalendar,
  unmirrorImpact,
} from "./store.js";

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
  overrides: Partial<typeof calendars.$inferInsert> = {},
): Promise<string> {
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
    googleSyncToken: "some-token",
    missingConfirmations: 0,
    ...overrides,
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

describe("ensurePersonalCalendar's Reminder Default seed (#244, ADR-0028)", () => {
  it("seeds 10 minutes before (timed) and 900 minutes before (all-day), reminders on", async () => {
    const userId = await createTestUser();
    await ensurePersonalCalendar(db, userId);

    const [local] = await db.select().from(calendars).where(eq(calendars.originType, "local"));

    expect(local?.remindersEnabled).toBe(true);
    expect(local?.reminderDefault).toEqual({
      timed: LOCAL_TIMED_REMINDER_DEFAULT,
      allDay: LOCAL_ALL_DAY_REMINDER_DEFAULT,
    });
  });
});

describe("ensurePersonalCalendar's Mail Account seed (#241, ADR-0027)", () => {
  it("seeds mailAccountId from the User's oldest Mail Account", async () => {
    const account = await createTestMailAccount(db);

    await ensurePersonalCalendar(db, account.userId);

    const [local] = await db.select().from(calendars).where(eq(calendars.originType, "local"));
    expect(local?.mailAccountId).toBe(account.id);
  });

  it("leaves mailAccountId null for a User with no Mail Account yet", async () => {
    const userId = await createTestUser();

    await ensurePersonalCalendar(db, userId);

    const [local] = await db.select().from(calendars).where(eq(calendars.originType, "local"));
    expect(local?.mailAccountId).toBeNull();
  });
});

describe("unmirrorCalendar", () => {
  it("discards every Occurrence, tombstones them, and flips mirrored off", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId);
    const eventId = await createEvent(userId, calendarId);

    const { calendar, discarded } = await unmirrorCalendar(db, userId, calendarId);

    expect(discarded).toEqual({ events: 1 });
    expect(calendar.mirrored).toBe(false);

    const remainingEvents = await db.select().from(events).where(eq(events.id, eventId));
    expect(remainingEvents).toHaveLength(0);

    const tombstones = await db.select().from(syncTombstones);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.collection).toBe("Event");
    expect(tombstones[0]?.entityId).toBe(eventId);
  });

  it("keeps the Calendar row so it can be re-mirrored later", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId);

    await unmirrorCalendar(db, userId, calendarId);

    const rows = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    expect(rows).toHaveLength(1);
  });

  it("clears the Google sync cursor so a re-mirror starts a fresh initial list", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, { missingConfirmations: 1 });

    const { calendar } = await unmirrorCalendar(db, userId, calendarId);

    expect(calendar.googleSyncToken).toBeNull();
    expect(calendar.missingConfirmations).toBe(0);
  });

  it("falls back the default Calendar to the Local Personal Calendar silently", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, { isDefault: true });

    const { calendar } = await unmirrorCalendar(db, userId, calendarId);

    expect(calendar.isDefault).toBe(false);
    const [personal] = await db.select().from(calendars).where(eq(calendars.originType, "local"));
    expect(personal?.isDefault).toBe(true);
  });

  it("is idempotent — unmirroring an already-unmirrored Calendar discards nothing further", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, { mirrored: false });
    await createEvent(userId, calendarId);

    const { discarded } = await unmirrorCalendar(db, userId, calendarId);

    expect(discarded).toEqual({ events: 0 });
    const remainingEvents = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(remainingEvents).toHaveLength(1);
  });

  it("refuses a Calendar id belonging to another User", async () => {
    const userId = await createTestUser();
    const otherUserId = await createTestUser();
    const calendarId = await createMirroredCalendar(otherUserId);

    await expect(unmirrorCalendar(db, userId, calendarId)).rejects.toBeInstanceOf(
      CalendarNotFoundError,
    );
  });

  it("refuses a Local Calendar — there is no checklist to turn it off from", async () => {
    const userId = await createTestUser();
    await ensurePersonalCalendar(db, userId);
    const [local] = await db.select().from(calendars).where(eq(calendars.originType, "local"));

    await expect(unmirrorCalendar(db, userId, local?.id ?? "")).rejects.toBeInstanceOf(
      CalendarNotMirrorableError,
    );
  });
});

describe("mirrorCalendar", () => {
  it("flips mirrored back on", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, { mirrored: false });

    const calendar = await mirrorCalendar(db, userId, calendarId);

    expect(calendar.mirrored).toBe(true);
  });

  it("is idempotent for an already-mirrored Calendar", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId, { mirrored: true });

    const calendar = await mirrorCalendar(db, userId, calendarId);

    expect(calendar.mirrored).toBe(true);
  });
});

describe("unmirrorImpact", () => {
  it("previews the discard count without deleting anything", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId);
    await createEvent(userId, calendarId);
    await createEvent(userId, calendarId);

    const impact = await unmirrorImpact(db, userId, calendarId);

    expect(impact).toEqual({ events: 2 });
    const remainingEvents = await db.select().from(events).where(eq(events.calendarId, calendarId));
    expect(remainingEvents).toHaveLength(2);
  });
});
