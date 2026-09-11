import { randomUUID } from "node:crypto";
import { HOME_TIME_ZONE_UNSET, LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  type CalendarRow,
  calendars,
  events,
  reminderDue,
  type SeriesRow,
  series,
  users,
} from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  effectiveReminderMinutes,
  occurrenceRealInstant,
  rebuildReminderDueForCalendar,
  rebuildReminderDueForSeries,
  rebuildReminderDueForUser,
  snoozeReminderDue,
} from "./reminder-due-store.js";

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

async function createTestUser(homeTimeZone = "Europe/Amsterdam"): Promise<string> {
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

async function createCalendar(
  userId: string,
  patch: Partial<{
    remindersEnabled: boolean;
    reminderDefault: CalendarRow["reminderDefault"];
  }> = {},
): Promise<string> {
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
    remindersEnabled: patch.remindersEnabled ?? true,
    reminderDefault: patch.reminderDefault ?? { timed: [10], allDay: [900] },
  });
  return id;
}

/** Inserts a Series row directly — this module's tests exercise `rebuildReminderDueForSeries` on its own, not through the materialiser. */
async function insertSeries(
  userId: string,
  calendarId: string,
  patch: Partial<SeriesRow> = {},
): Promise<SeriesRow> {
  const id = patch.id ?? randomUUID();
  const values = {
    id,
    userId,
    calendarId,
    uid: `${id}@test`,
    sequence: 0,
    title: "Standup",
    description: null,
    location: null,
    allDay: false,
    floating: false,
    tzid: "UTC",
    dtstart: new Date("2026-01-05T09:00:00.000Z"),
    durationMs: 60 * 60 * 1000,
    rrules: [],
    rdates: [],
    exdates: [],
    transparency: "opaque" as const,
    attendees: [],
    reminders: [],
    upstreamId: null,
    etag: null,
    upstreamSnapshot: null,
    deletedAt: null,
    ...patch,
  };
  await db.insert(series).values(values);
  const [row] = await db.select().from(series).where(eq(series.id, id));
  if (!row) throw new Error("insertSeries: row not found after insert");
  return row;
}

/** Inserts one materialised Occurrence directly, at `<seriesId>@<originalStart>` per ADR-0025's own convention. */
async function insertEvent(
  seriesRow: Pick<SeriesRow, "id" | "userId" | "calendarId" | "allDay" | "floating" | "tzid">,
  originalStart: Date,
  patch: Partial<{
    startAt: Date;
    endAt: Date;
    status: "confirmed" | "cancelled";
    location: string | null;
  }> = {},
): Promise<string> {
  const startAt = patch.startAt ?? originalStart;
  const endAt = patch.endAt ?? new Date(startAt.getTime() + 60 * 60 * 1000);
  const id = `${seriesRow.id}@${originalStart.toISOString()}`;
  await db.insert(events).values({
    id,
    userId: seriesRow.userId,
    calendarId: seriesRow.calendarId,
    seriesId: seriesRow.id,
    originalStart,
    startAt,
    endAt,
    allDay: seriesRow.allDay,
    tzid: seriesRow.tzid,
    floating: seriesRow.floating,
    title: "Standup",
    location: patch.location ?? null,
    status: patch.status ?? "confirmed",
    transparency: "opaque",
  });
  return id;
}

describe("effectiveReminderMinutes", () => {
  it("falls back to the Calendar's timed default when the Series set no Reminders", () => {
    expect(effectiveReminderMinutes([], { timed: [10, 30], allDay: [900] }, false)).toEqual([
      10, 30,
    ]);
  });

  it("falls back to the Calendar's all-day default for an all-day Occurrence", () => {
    expect(effectiveReminderMinutes([], { timed: [10], allDay: [900] }, true)).toEqual([900]);
  });

  it("uses the Series' own visible Reminders when it set any, ignoring email/absolute ones", () => {
    const minutes = effectiveReminderMinutes(
      [
        { kind: "relative", method: "popup", minutesBefore: 5 },
        { kind: "relative", method: "email", minutesBefore: 1440 },
      ],
      { timed: [10], allDay: [900] },
      false,
    );
    expect(minutes).toEqual([5]);
  });
});

describe("occurrenceRealInstant", () => {
  it("passes a zoned/plain instant through unchanged", () => {
    const instant = new Date("2026-09-10T09:00:00.000Z");
    expect(occurrenceRealInstant(instant, false, HOME_TIME_ZONE_UNSET)).toEqual(instant);
  });

  it("resolves an all-day/floating wall clock in the Home Time Zone", () => {
    // Midnight UTC-labeled wall clock, Amsterdam is UTC+2 in September.
    const wallClock = new Date("2026-09-10T00:00:00.000Z");
    const resolved = occurrenceRealInstant(wallClock, true, "Europe/Amsterdam");
    expect(resolved).toEqual(new Date("2026-09-09T22:00:00.000Z"));
  });

  it("returns null when zoning is needed but the Home Time Zone isn't seeded yet", () => {
    const wallClock = new Date("2026-09-10T00:00:00.000Z");
    expect(occurrenceRealInstant(wallClock, true, HOME_TIME_ZONE_UNSET)).toBeNull();
  });
});

describe("rebuildReminderDueForSeries", () => {
  it("builds one row per Occurrence per effective Reminder minute", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10, 30], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T08:00:00.000Z");
    const occurrenceStart = new Date("2026-09-09T09:00:00.000Z");
    const eventId = await insertEvent(seriesRow, occurrenceStart);
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    if (!calendarRow) throw new Error("calendar row missing");

    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);

    const rows = await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId));
    expect(rows.map((row) => row.minutesBefore).sort()).toEqual([10, 30]);
    const tenMinRow = rows.find((row) => row.minutesBefore === 10);
    expect(tenMinRow?.dueAt).toEqual(new Date("2026-09-09T08:50:00.000Z"));
    expect(tenMinRow?.status).toBe("pending");
  });

  it("resolves an all-day Occurrence's dueAt in the Home Time Zone", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [], allDay: [900] },
    });
    const seriesRow = await insertSeries(userId, calendarId, { allDay: true });
    const now = new Date("2026-09-01T00:00:00.000Z");
    // Midnight UTC-labeled wall clock for an all-day Occurrence starting Sept 10.
    const wallClockStart = new Date("2026-09-10T00:00:00.000Z");
    const eventId = await insertEvent(seriesRow, wallClockStart, {
      endAt: new Date("2026-09-11T00:00:00.000Z"),
    });
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    if (!calendarRow) throw new Error("calendar row missing");

    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "Europe/Amsterdam", now);

    const [row] = await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId));
    // Real midnight in Amsterdam (UTC+2 in September, so 2026-09-09T22:00Z) minus 900 minutes (15h).
    expect(row?.dueAt).toEqual(new Date("2026-09-09T07:00:00.000Z"));
  });

  it("recomputes dueAt and clears firedAt when the Occurrence moves", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T08:00:00.000Z");
    const originalStart = new Date("2026-09-09T09:00:00.000Z");
    const eventId = await insertEvent(seriesRow, originalStart);
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    if (!calendarRow) throw new Error("calendar row missing");

    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);
    const rowId = `${eventId}:10`;
    await db
      .update(reminderDue)
      .set({ status: "fired", firedAt: now })
      .where(eq(reminderDue.id, rowId));

    // The Event moves an hour later.
    await db
      .update(events)
      .set({
        startAt: new Date("2026-09-09T10:00:00.000Z"),
        endAt: new Date("2026-09-09T11:00:00.000Z"),
      })
      .where(eq(events.id, eventId));

    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);

    const [row] = await db.select().from(reminderDue).where(eq(reminderDue.id, rowId));
    expect(row?.dueAt).toEqual(new Date("2026-09-09T09:50:00.000Z"));
    expect(row?.status).toBe("pending");
    expect(row?.firedAt).toBeNull();
  });

  it("leaves a fired row's outcome alone when a rebuild recomputes the same dueAt", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T08:00:00.000Z");
    const originalStart = new Date("2026-09-09T09:00:00.000Z");
    const eventId = await insertEvent(seriesRow, originalStart);
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    if (!calendarRow) throw new Error("calendar row missing");

    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);
    const rowId = `${eventId}:10`;
    const firedAt = new Date("2026-09-09T08:50:00.000Z");
    await db.update(reminderDue).set({ status: "fired", firedAt }).where(eq(reminderDue.id, rowId));

    // A daily roll re-runs against exactly the same Occurrence timing.
    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);

    const [row] = await db.select().from(reminderDue).where(eq(reminderDue.id, rowId));
    expect(row?.status).toBe("fired");
    expect(row?.firedAt).toEqual(firedAt);
  });

  it("deletes every row when the Calendar's toggle is off", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, { remindersEnabled: false });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T08:00:00.000Z");
    await insertEvent(seriesRow, new Date("2026-09-09T09:00:00.000Z"));
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    if (!calendarRow) throw new Error("calendar row missing");

    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);

    const rows = await db.select().from(reminderDue).where(eq(reminderDue.seriesId, seriesRow.id));
    expect(rows).toHaveLength(0);
  });

  it("deletes every row when the User declined this Series' Invitation", async () => {
    const userId = await createTestUser();
    const mailAccount = await createTestMailAccount(db, {
      userId,
      emailAddress: "reader@example.com",
    });
    const calendarId = `synced:${randomUUID()}`;
    await db.insert(calendars).values({
      id: calendarId,
      userId,
      name: "Work",
      description: null,
      timeZone: "UTC",
      originType: "connectedAccount",
      connectedAccountId: mailAccount.connectedAccountId,
      color: "#4285F4",
      isDefault: false,
      mailAccountId: null,
      mirrored: true,
      capabilities: { ...LOCAL_CALENDAR_CAPABILITIES, invitesSentByUpstream: true },
      remindersEnabled: true,
      reminderDefault: { timed: [10], allDay: [] },
    });

    const seriesRow = await insertSeries(userId, calendarId, {
      attendees: [{ email: "reader@example.com", name: null, responseStatus: "declined" }],
    });
    const now = new Date("2026-09-09T08:00:00.000Z");
    await insertEvent(seriesRow, new Date("2026-09-09T09:00:00.000Z"));
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    if (!calendarRow) throw new Error("calendar row missing");

    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);

    const rows = await db.select().from(reminderDue).where(eq(reminderDue.seriesId, seriesRow.id));
    expect(rows).toHaveLength(0);
  });

  it("never builds a row for a cancelled Occurrence", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T08:00:00.000Z");
    await insertEvent(seriesRow, new Date("2026-09-09T09:00:00.000Z"), { status: "cancelled" });
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    if (!calendarRow) throw new Error("calendar row missing");

    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);

    const rows = await db.select().from(reminderDue).where(eq(reminderDue.seriesId, seriesRow.id));
    expect(rows).toHaveLength(0);
  });

  it("never builds a row for an Occurrence that has already ended", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T12:00:00.000Z");
    await insertEvent(seriesRow, new Date("2026-09-09T09:00:00.000Z"), {
      endAt: new Date("2026-09-09T10:00:00.000Z"),
    });
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    if (!calendarRow) throw new Error("calendar row missing");

    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);

    const rows = await db.select().from(reminderDue).where(eq(reminderDue.seriesId, seriesRow.id));
    expect(rows).toHaveLength(0);
  });

  it("drops a stale row once its minutesBefore is no longer offered", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10, 30], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T08:00:00.000Z");
    const eventId = await insertEvent(seriesRow, new Date("2026-09-09T09:00:00.000Z"));
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    if (!calendarRow) throw new Error("calendar row missing");
    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);
    expect(
      await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId)),
    ).toHaveLength(2);

    await db
      .update(calendars)
      .set({ reminderDefault: { timed: [10], allDay: [] } })
      .where(eq(calendars.id, calendarId));
    const [narrowedCalendar] = await db
      .select()
      .from(calendars)
      .where(eq(calendars.id, calendarId));
    if (!narrowedCalendar) throw new Error("calendar row missing");
    await rebuildReminderDueForSeries(db, seriesRow, narrowedCalendar, "UTC", now);

    const rows = await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId));
    expect(rows.map((row) => row.minutesBefore)).toEqual([10]);
  });

  it("leaves a snoozed row alone — a rebuild neither recomputes nor drops it (#246, ADR-0028)", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T08:00:00.000Z");
    const eventId = await insertEvent(seriesRow, new Date("2026-09-09T09:00:00.000Z"));
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    if (!calendarRow) throw new Error("calendar row missing");
    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);

    const snoozedId = `${eventId}:10:snooze`;
    await db.insert(reminderDue).values({
      id: snoozedId,
      userId,
      calendarId,
      seriesId: seriesRow.id,
      eventId,
      originalStart: new Date("2026-09-09T09:00:00.000Z"),
      minutesBefore: 10,
      dueAt: new Date("2026-09-09T08:05:00.000Z"),
      status: "pending",
      firedAt: null,
      snoozed: true,
    });

    // A daily roll re-runs against the exact same Occurrence timing — the
    // ordinary row's own `dueAt`/`status` are untouched by this rebuild
    // either way, so the snoozed row surviving unchanged is the only thing
    // this assertion is actually about.
    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);

    const [snoozedRow] = await db.select().from(reminderDue).where(eq(reminderDue.id, snoozedId));
    expect(snoozedRow?.dueAt).toEqual(new Date("2026-09-09T08:05:00.000Z"));
    expect(snoozedRow?.status).toBe("pending");
  });
});

describe("rebuildReminderDueForCalendar / rebuildReminderDueForUser", () => {
  it("rebuilds every Series on the Calendar when the Reminder Default changes", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesA = await insertSeries(userId, calendarId);
    const seriesB = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T08:00:00.000Z");
    const eventA = await insertEvent(seriesA, new Date("2026-09-09T09:00:00.000Z"));
    const eventB = await insertEvent(seriesB, new Date("2026-09-09T09:00:00.000Z"));

    await db
      .update(calendars)
      .set({ reminderDefault: { timed: [5, 15], allDay: [] } })
      .where(eq(calendars.id, calendarId));
    await rebuildReminderDueForCalendar(db, calendarId, now);

    const rowsA = await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventA));
    const rowsB = await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventB));
    expect(rowsA.map((row) => row.minutesBefore).sort((a, b) => a - b)).toEqual([5, 15]);
    expect(rowsB.map((row) => row.minutesBefore).sort((a, b) => a - b)).toEqual([5, 15]);
  });

  it("rebuilds every Calendar's Series when the User's Home Time Zone changes", async () => {
    const userId = await createTestUser("UTC");
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [], allDay: [900] },
    });
    const seriesRow = await insertSeries(userId, calendarId, { allDay: true });
    const now = new Date("2026-09-01T00:00:00.000Z");
    const wallClockStart = new Date("2026-09-10T00:00:00.000Z");
    const eventId = await insertEvent(seriesRow, wallClockStart, {
      endAt: new Date("2026-09-11T00:00:00.000Z"),
    });

    await db.update(users).set({ homeTimeZone: "Europe/Amsterdam" }).where(eq(users.id, userId));
    await rebuildReminderDueForUser(db, userId, now);

    const [row] = await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId));
    expect(row?.dueAt).toEqual(new Date("2026-09-09T07:00:00.000Z"));
  });
});

describe("snoozeReminderDue", () => {
  async function fireRow(
    seriesRow: SeriesRow,
    calendarId: string,
    eventId: string,
    now: Date,
  ): Promise<string> {
    const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, calendarId));
    if (!calendarRow) throw new Error("calendar row missing");
    await rebuildReminderDueForSeries(db, seriesRow, calendarRow, "UTC", now);
    const rowId = `${eventId}:10`;
    await db
      .update(reminderDue)
      .set({ status: "fired", firedAt: now })
      .where(eq(reminderDue.id, rowId));
    return rowId;
  }

  it("inserts a one-off pending row due `now + N` minutes, flagged snoozed", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T08:00:00.000Z");
    const eventId = await insertEvent(seriesRow, new Date("2026-09-09T09:00:00.000Z"));
    const firedId = await fireRow(seriesRow, calendarId, eventId, now);

    const result = await snoozeReminderDue(
      db,
      userId,
      firedId,
      { kind: "minutes", minutes: 5 },
      now,
    );
    expect(result).toEqual({ ok: true });

    const rows = await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId));
    const snoozedRow = rows.find((row) => row.id !== firedId);
    expect(snoozedRow?.snoozed).toBe(true);
    expect(snoozedRow?.status).toBe("pending");
    expect(snoozedRow?.dueAt).toEqual(new Date("2026-09-09T08:05:00.000Z"));
    // The original fired row is left exactly as it was.
    const [original] = await db.select().from(reminderDue).where(eq(reminderDue.id, firedId));
    expect(original?.status).toBe("fired");
  });

  it("resolves 'at start' to the Occurrence's own real start", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T08:00:00.000Z");
    const eventId = await insertEvent(seriesRow, new Date("2026-09-09T09:00:00.000Z"));
    const firedId = await fireRow(seriesRow, calendarId, eventId, now);

    const result = await snoozeReminderDue(db, userId, firedId, { kind: "eventStart" }, now);
    expect(result).toEqual({ ok: true });

    const rows = await db.select().from(reminderDue).where(eq(reminderDue.eventId, eventId));
    const snoozedRow = rows.find((row) => row.id !== firedId);
    expect(snoozedRow?.dueAt).toEqual(new Date("2026-09-09T09:00:00.000Z"));
  });

  it("rejects 'at start' once the Occurrence has already begun", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T09:05:00.000Z");
    const eventId = await insertEvent(seriesRow, new Date("2026-09-09T09:00:00.000Z"), {
      endAt: new Date("2026-09-09T10:00:00.000Z"),
    });
    const firedId = await fireRow(
      seriesRow,
      calendarId,
      eventId,
      new Date("2026-09-09T08:50:00.000Z"),
    );

    const result = await snoozeReminderDue(db, userId, firedId, { kind: "eventStart" }, now);
    expect(result).toEqual({ ok: false, reason: "event_already_started" });
  });

  it("rejects once the Occurrence has ended", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const eventId = await insertEvent(seriesRow, new Date("2026-09-09T09:00:00.000Z"), {
      endAt: new Date("2026-09-09T10:00:00.000Z"),
    });
    const firedId = await fireRow(
      seriesRow,
      calendarId,
      eventId,
      new Date("2026-09-09T08:50:00.000Z"),
    );

    const now = new Date("2026-09-09T10:30:00.000Z");
    const result = await snoozeReminderDue(
      db,
      userId,
      firedId,
      { kind: "minutes", minutes: 5 },
      now,
    );
    expect(result).toEqual({ ok: false, reason: "event_ended" });
  });

  it("rejects a fired row belonging to a different User", async () => {
    const userId = await createTestUser();
    const otherUserId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T08:00:00.000Z");
    const eventId = await insertEvent(seriesRow, new Date("2026-09-09T09:00:00.000Z"));
    const firedId = await fireRow(seriesRow, calendarId, eventId, now);

    const result = await snoozeReminderDue(
      db,
      otherUserId,
      firedId,
      { kind: "minutes", minutes: 5 },
      now,
    );
    expect(result).toEqual({ ok: false, reason: "reminder_not_found" });
  });

  it("rejects a Reminder Due id that no longer resolves to a live Occurrence", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId, {
      reminderDefault: { timed: [10], allDay: [] },
    });
    const seriesRow = await insertSeries(userId, calendarId);
    const now = new Date("2026-09-09T08:00:00.000Z");
    const eventId = await insertEvent(seriesRow, new Date("2026-09-09T09:00:00.000Z"));
    const firedId = await fireRow(seriesRow, calendarId, eventId, now);
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, eventId));

    const result = await snoozeReminderDue(
      db,
      userId,
      firedId,
      { kind: "minutes", minutes: 5 },
      now,
    );
    expect(result).toEqual({ ok: false, reason: "event_not_found" });
  });
});
