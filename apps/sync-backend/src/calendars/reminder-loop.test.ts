import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { calendars, events, notifierOutbox, reminderDue, series, users } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { runReminderTick } from "./reminder-loop.js";

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

async function createUser(homeTimeZone = "UTC"): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    username: `user-${id.slice(0, 8)}`,
    passwordHash: "not-a-real-hash",
    role: "owner",
    homeTimeZone,
  });
  return id;
}

async function createCalendar(userId: string): Promise<string> {
  const id = `local:${randomUUID()}`;
  await db.insert(calendars).values({
    id,
    userId,
    name: "Personal",
    description: null,
    timeZone: "UTC",
    originType: "local",
    connectedAccountId: null,
    color: "#4285F4",
    isDefault: true,
    mailAccountId: null,
    mirrored: true,
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
  });
  return id;
}

/** A fully-wired Series + Occurrence + Reminder Due row, ready for `runReminderTick` to claim — this module's tests drive the loop directly rather than through `rebuildReminderDueForSeries`. */
async function setUpReminder(
  userId: string,
  calendarId: string,
  patch: Partial<{
    startAt: Date;
    endAt: Date;
    minutesBefore: number;
    dueAt: Date;
    status: "pending" | "fired" | "missed";
    eventStatus: "confirmed" | "cancelled";
    location: string | null;
  }> = {},
): Promise<{ seriesId: string; eventId: string; reminderDueId: string }> {
  const seriesId = randomUUID();
  await db.insert(series).values({
    id: seriesId,
    userId,
    calendarId,
    uid: `${seriesId}@test`,
    sequence: 0,
    title: "Standup",
    description: null,
    location: null,
    allDay: false,
    floating: false,
    tzid: "UTC",
    dtstart: new Date("2026-09-09T09:00:00.000Z"),
    durationMs: 60 * 60 * 1000,
    rrules: [],
    rdates: [],
    exdates: [],
    transparency: "opaque",
    attendees: [],
    reminders: [],
  });

  const originalStart = new Date("2026-09-09T09:00:00.000Z");
  const startAt = patch.startAt ?? originalStart;
  const endAt = patch.endAt ?? new Date(startAt.getTime() + 60 * 60 * 1000);
  const eventId = `${seriesId}@${originalStart.toISOString()}`;
  await db.insert(events).values({
    id: eventId,
    userId,
    calendarId,
    seriesId,
    originalStart,
    startAt,
    endAt,
    allDay: false,
    tzid: "UTC",
    floating: false,
    title: "Standup",
    location: patch.location ?? "Room 204",
    status: patch.eventStatus ?? "confirmed",
    transparency: "opaque",
  });

  const minutesBefore = patch.minutesBefore ?? 10;
  const reminderDueId = `${eventId}:${minutesBefore}`;
  await db.insert(reminderDue).values({
    id: reminderDueId,
    userId,
    calendarId,
    seriesId,
    eventId,
    originalStart,
    minutesBefore,
    dueAt: patch.dueAt ?? new Date(startAt.getTime() - minutesBefore * 60_000),
    status: patch.status ?? "pending",
  });

  return { seriesId, eventId, reminderDueId };
}

describe("runReminderTick", () => {
  it("fires a Reminder that is due but hasn't started yet, 'in N min'", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const now = new Date("2026-09-09T08:52:00.000Z"); // Occurrence starts 09:00, due at 08:50.
    const { reminderDueId, seriesId, eventId } = await setUpReminder(userId, calendarId);

    await runReminderTick(db, { now });

    const [row] = await db.select().from(reminderDue).where(eq(reminderDue.id, reminderDueId));
    expect(row?.status).toBe("fired");

    const [outboxRow] = await db
      .select()
      .from(notifierOutbox)
      .where(eq(notifierOutbox.kind, "calendar_reminder"));
    expect(outboxRow?.userId).toBe(userId);
    expect(outboxRow?.dedupKey).toBe(
      `${seriesId}:2026-09-09T09:00:00.000Z:10:${row?.dueAt.toISOString()}`,
    );
    if (outboxRow?.payload.kind !== "calendar_reminder") throw new Error("wrong payload kind");
    expect(outboxRow.payload.events).toEqual([
      {
        reminderDueId,
        eventId,
        seriesId,
        title: "Standup",
        body: "in 8 min · 9:00 AM–10:00 AM · Room 204",
      },
    ]);
  });

  it("fires once as 'started N min ago' within the catch-up grace window", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    // Occurrence started at 09:00; claimed at 09:05, 5 minutes late.
    const now = new Date("2026-09-09T09:05:00.000Z");
    const { reminderDueId } = await setUpReminder(userId, calendarId, {
      dueAt: new Date("2026-09-09T08:50:00.000Z"),
    });

    await runReminderTick(db, { now });

    const [row] = await db.select().from(reminderDue).where(eq(reminderDue.id, reminderDueId));
    expect(row?.status).toBe("fired");
    const [outboxRow] = await db
      .select()
      .from(notifierOutbox)
      .where(eq(notifierOutbox.kind, "calendar_reminder"));
    if (outboxRow?.payload.kind !== "calendar_reminder") throw new Error("wrong payload kind");
    expect(outboxRow.payload.events[0]?.body).toMatch(/^started 5 min ago/);
  });

  it("marks a Reminder missed silently once 15 minutes have passed since start", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const now = new Date("2026-09-09T09:16:00.000Z"); // 16 minutes after a 09:00 start.
    const { reminderDueId } = await setUpReminder(userId, calendarId, {
      dueAt: new Date("2026-09-09T08:50:00.000Z"),
      endAt: new Date("2026-09-09T11:00:00.000Z"),
    });

    await runReminderTick(db, { now });

    const [row] = await db.select().from(reminderDue).where(eq(reminderDue.id, reminderDueId));
    expect(row?.status).toBe("missed");
    const outboxRows = await db.select().from(notifierOutbox);
    expect(outboxRows).toHaveLength(0);
  });

  it("never fires an Occurrence that has already ended", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const now = new Date("2026-09-09T10:05:00.000Z"); // Occurrence ended at 10:00.
    const { reminderDueId } = await setUpReminder(userId, calendarId, {
      dueAt: new Date("2026-09-09T08:50:00.000Z"),
    });

    await runReminderTick(db, { now });

    const [row] = await db.select().from(reminderDue).where(eq(reminderDue.id, reminderDueId));
    expect(row?.status).toBe("missed");
  });

  it("misses silently when the Occurrence was cancelled after this row was built", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const now = new Date("2026-09-09T08:52:00.000Z");
    const { reminderDueId } = await setUpReminder(userId, calendarId, { eventStatus: "cancelled" });

    await runReminderTick(db, { now });

    const [row] = await db.select().from(reminderDue).where(eq(reminderDue.id, reminderDueId));
    expect(row?.status).toBe("missed");
    expect(await db.select().from(notifierOutbox)).toHaveLength(0);
  });

  it("only ever claims a due row once, even if it appears twice in one tick's candidate list", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const now = new Date("2026-09-09T08:52:00.000Z");
    const { reminderDueId } = await setUpReminder(userId, calendarId);

    await Promise.all([runReminderTick(db, { now }), runReminderTick(db, { now })]);

    const outboxRows = await db
      .select()
      .from(notifierOutbox)
      .where(eq(notifierOutbox.kind, "calendar_reminder"));
    expect(outboxRows).toHaveLength(1);
    const [row] = await db.select().from(reminderDue).where(eq(reminderDue.id, reminderDueId));
    expect(row?.status).toBe("fired");
  });

  it("leaves a not-yet-due row alone", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const now = new Date("2026-09-09T08:00:00.000Z"); // Due at 08:50, an hour from now.
    const { reminderDueId } = await setUpReminder(userId, calendarId);

    await runReminderTick(db, { now });

    const [row] = await db.select().from(reminderDue).where(eq(reminderDue.id, reminderDueId));
    expect(row?.status).toBe("pending");
    expect(await db.select().from(notifierOutbox)).toHaveLength(0);
  });
});
