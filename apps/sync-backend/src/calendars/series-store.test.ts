import { randomUUID } from "node:crypto";
import type { SeriesSave } from "@mail/shared";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  calendarOutbox,
  calendars,
  events,
  imipRequests,
  overrides,
  series,
  users,
} from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  addExdate,
  answerInvitation,
  applySeriesSave,
  createSeriesSkeleton,
  deleteSeriesPermanently,
  moveSeries,
  removeExdate,
  restoreSeries,
  trashSeries,
} from "./series-store.js";

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

async function createCalendarWithMailAccount(
  userId: string,
  mailAccountId: string,
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
    mailAccountId,
    mirrored: true,
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
  });
  return id;
}

/** A minimal weekly-recurring Series save, one hour long, no rules unless overridden. */
function saveFor(
  seriesId: string,
  calendarId: string,
  patch: Partial<SeriesSave> = {},
): SeriesSave {
  return {
    id: seriesId,
    saveId: randomUUID(),
    calendarId,
    title: "Standup",
    description: null,
    location: null,
    allDay: false,
    floating: false,
    tzid: "UTC",
    dtstart: "2026-01-05T09:00:00.000Z",
    durationMs: 60 * 60 * 1000,
    rrules: ["FREQ=WEEKLY"],
    rdates: [],
    exdates: [],
    transparency: "opaque",
    attendees: [],
    reminders: [],
    overrides: [],
    ...patch,
    sendUpdate: patch.sendUpdate ?? true,
  };
}

describe("createSeriesSkeleton", () => {
  it("rejects a calendarId this User doesn't own", async () => {
    const userId = await createTestUser();
    const otherUserId = await createTestUser();
    const calendarId = await createCalendar(otherUserId);

    const result = await createSeriesSkeleton(db, userId, randomUUID(), calendarId);

    expect(result).toEqual({ ok: false, reason: "calendar_not_found" });
  });

  it("inserts an empty row, and is idempotent by id (a retried mutation)", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();

    expect(await createSeriesSkeleton(db, userId, seriesId, calendarId)).toEqual({ ok: true });
    expect(await createSeriesSkeleton(db, userId, seriesId, calendarId)).toEqual({ ok: true });

    const rows = await db.select().from(series).where(eq(series.id, seriesId));
    expect(rows).toHaveLength(1);
  });
});

describe("applySeriesSave", () => {
  it("creates the row lazily when no createSeries skeleton landed first", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();

    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));

    const [row] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(row?.title).toBe("Standup");
    expect(row?.rrules).toEqual(["FREQ=WEEKLY"]);
  });

  it("persists reminders (#244, ADR-0028) — round-trips through toWireSeries too", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();

    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, calendarId, {
        reminders: [
          { kind: "relative", method: "popup", minutesBefore: 10 },
          { kind: "relative", method: "email", minutesBefore: 1440 },
        ],
      }),
    );

    const [row] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(row?.reminders).toEqual([
      { kind: "relative", method: "popup", minutesBefore: 10 },
      { kind: "relative", method: "email", minutesBefore: 1440 },
    ]);
  });

  it("re-materialises Occurrences immediately, no daily sweep needed", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();

    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));

    const rows = await db.select().from(events).where(eq(events.seriesId, seriesId));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("replaces the whole Override set on every save", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();
    const overrideId = randomUUID();

    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, calendarId, {
        overrides: [
          {
            id: overrideId,
            originalStart: "2026-01-05T09:00:00.000Z",
            start: "2026-01-05T10:00:00.000Z",
            end: "2026-01-05T11:00:00.000Z",
            title: "Standup (moved)",
            location: null,
          },
        ],
      }),
    );
    let overrideRows = await db.select().from(overrides).where(eq(overrides.seriesId, seriesId));
    expect(overrideRows).toHaveLength(1);

    await applySeriesSave(db, userId, saveFor(seriesId, calendarId, { overrides: [] }));
    overrideRows = await db.select().from(overrides).where(eq(overrides.seriesId, seriesId));
    expect(overrideRows).toHaveLength(0);
  });

  it("leaves a row owned by a different User untouched", async () => {
    const ownerId = await createTestUser();
    const attackerId = await createTestUser();
    const calendarId = await createCalendar(ownerId);
    const seriesId = randomUUID();
    await applySeriesSave(db, ownerId, saveFor(seriesId, calendarId));

    await applySeriesSave(db, attackerId, saveFor(seriesId, calendarId, { title: "Hijacked" }));

    const [row] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(row?.title).toBe("Standup");
    expect(row?.userId).toBe(ownerId);
  });
});

describe("trashSeries / restoreSeries", () => {
  it("tears down Occurrences at once and restoring re-materialises them", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));
    expect(await db.select().from(events).where(eq(events.seriesId, seriesId))).not.toHaveLength(0);

    expect(await trashSeries(db, userId, seriesId)).toEqual({ ok: true });
    expect(await db.select().from(events).where(eq(events.seriesId, seriesId))).toHaveLength(0);
    const [trashedRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(trashedRow?.deletedAt).not.toBeNull();

    expect(await restoreSeries(db, userId, seriesId)).toEqual({ ok: true });
    expect(await db.select().from(events).where(eq(events.seriesId, seriesId))).not.toHaveLength(0);
    const [restoredRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(restoredRow?.deletedAt).toBeNull();
  });

  it("rejects series_not_found for an id this User doesn't have", async () => {
    const userId = await createTestUser();
    expect(await trashSeries(db, userId, randomUUID())).toEqual({
      ok: false,
      reason: "series_not_found",
    });
    expect(await restoreSeries(db, userId, randomUUID())).toEqual({
      ok: false,
      reason: "series_not_found",
    });
  });

  it("is a harmless no-op when already in the requested state (a retried mutation)", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));

    await trashSeries(db, userId, seriesId);
    expect(await trashSeries(db, userId, seriesId)).toEqual({ ok: true });
    await restoreSeries(db, userId, seriesId);
    expect(await restoreSeries(db, userId, seriesId)).toEqual({ ok: true });
  });
});

describe("addExdate / removeExdate", () => {
  it("is a real inverse pair, re-materialising immediately", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));
    const before = await db.select().from(events).where(eq(events.seriesId, seriesId));

    await addExdate(db, userId, seriesId, "2026-01-05T09:00:00.000Z");
    const afterExdate = await db.select().from(events).where(eq(events.seriesId, seriesId));
    expect(afterExdate.length).toBe(before.length - 1);
    let [row] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(row?.exdates).toEqual(["2026-01-05T09:00:00.000Z"]);

    await removeExdate(db, userId, seriesId, "2026-01-05T09:00:00.000Z");
    const afterUndo = await db.select().from(events).where(eq(events.seriesId, seriesId));
    expect(afterUndo.length).toBe(before.length);
    [row] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(row?.exdates).toEqual([]);
  });

  it("absorbs a duplicate exdate rather than appending it twice", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));

    await addExdate(db, userId, seriesId, "2026-01-05T09:00:00.000Z");
    await addExdate(db, userId, seriesId, "2026-01-05T09:00:00.000Z");

    const [row] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(row?.exdates).toEqual(["2026-01-05T09:00:00.000Z"]);
  });
});

describe("deleteSeriesPermanently", () => {
  it("tears down Occurrences and physically removes the row", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));

    await deleteSeriesPermanently(db, userId, seriesId);

    expect(await db.select().from(series).where(eq(series.id, seriesId))).toHaveLength(0);
    expect(await db.select().from(events).where(eq(events.seriesId, seriesId))).toHaveLength(0);
  });

  it("is a harmless no-op for an id already gone", async () => {
    const userId = await createTestUser();
    await expect(deleteSeriesPermanently(db, userId, randomUUID())).resolves.toBeUndefined();
  });
});

/** A mirrored, writable Connected-Account Calendar — `shouldPushUpstream`'s own gate (#237). */
async function createMirroredCalendar(
  userId: string,
  connectedAccountId: string = randomUUID(),
): Promise<string> {
  const id = `gcal:${connectedAccountId}:${randomUUID()}`;
  await db.insert(calendars).values({
    id,
    userId,
    name: "Mirrored",
    description: null,
    timeZone: "UTC",
    originType: "connectedAccount",
    connectedAccountId,
    color: "#4285F4",
    isDefault: false,
    mailAccountId: null,
    mirrored: true,
    capabilities: { ...LOCAL_CALENDAR_CAPABILITIES, writable: true },
  });
  return id;
}

describe("write-back outbox enqueue (#237)", () => {
  it("a Local Calendar's Series save never enqueues an outbox row", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();

    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));

    expect(
      await db.select().from(calendarOutbox).where(eq(calendarOutbox.seriesId, seriesId)),
    ).toHaveLength(0);
  });

  it("a mirrored writable Calendar's Series save enqueues an 'upsert' outbox row", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId);
    const seriesId = randomUUID();

    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));

    const rows = await db
      .select()
      .from(calendarOutbox)
      .where(eq(calendarOutbox.seriesId, seriesId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: "upsert", sendInvitations: true });
  });

  it("trashSeries enqueues 'cancel'; restoreSeries enqueues 'restore'", async () => {
    const userId = await createTestUser();
    const calendarId = await createMirroredCalendar(userId);
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));

    await trashSeries(db, userId, seriesId);
    let rows = await db.select().from(calendarOutbox).where(eq(calendarOutbox.seriesId, seriesId));
    expect(rows[0]?.operation).toBe("cancel");

    await restoreSeries(db, userId, seriesId);
    rows = await db.select().from(calendarOutbox).where(eq(calendarOutbox.seriesId, seriesId));
    expect(rows[0]?.operation).toBe("restore");
  });
});

describe("answerInvitation (#240)", () => {
  it("rejects not_synced for a Local Calendar's Series", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));

    expect(await answerInvitation(db, userId, seriesId, "accepted")).toEqual({
      ok: false,
      reason: "not_synced",
    });
  });

  it("rejects not_attendee when the Mail Account's own address never appears in attendees", async () => {
    const userId = await createTestUser();
    const account = await createTestMailAccount(db, { userId });
    const calendarId = await createMirroredCalendar(userId, account.connectedAccountId);
    const seriesId = randomUUID();
    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, calendarId, {
        attendees: [
          { email: "someone-else@example.com", name: null, responseStatus: "needsAction" },
        ],
      }),
    );

    expect(await answerInvitation(db, userId, seriesId, "accepted")).toEqual({
      ok: false,
      reason: "not_attendee",
    });
  });

  it("rewrites the self attendee's responseStatus, returns the previous value, and enqueues a 'respond' outbox row", async () => {
    const userId = await createTestUser();
    const account = await createTestMailAccount(db, { userId });
    const calendarId = await createMirroredCalendar(userId, account.connectedAccountId);
    const seriesId = randomUUID();
    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, calendarId, {
        attendees: [
          { email: account.emailAddress, name: "Me", responseStatus: "needsAction" },
          { email: "organiser@example.com", name: null, responseStatus: "accepted" },
        ],
      }),
    );

    const result = await answerInvitation(db, userId, seriesId, "accepted");
    expect(result).toEqual({ ok: true, previousResponseStatus: "needsAction" });

    const [row] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(row?.attendees).toEqual([
      { email: account.emailAddress, name: "Me", responseStatus: "accepted" },
      { email: "organiser@example.com", name: null, responseStatus: "accepted" },
    ]);

    const outboxRows = await db
      .select()
      .from(calendarOutbox)
      .where(eq(calendarOutbox.seriesId, seriesId));
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({ operation: "respond", responseStatus: "accepted" });
  });

  it("a later Answer reports the just-set value as its own 'previous', letting Undo answer again with it", async () => {
    const userId = await createTestUser();
    const account = await createTestMailAccount(db, { userId });
    const calendarId = await createMirroredCalendar(userId, account.connectedAccountId);
    const seriesId = randomUUID();
    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, calendarId, {
        attendees: [{ email: account.emailAddress, name: null, responseStatus: "needsAction" }],
      }),
    );

    await answerInvitation(db, userId, seriesId, "tentative");
    const secondResult = await answerInvitation(db, userId, seriesId, "declined");
    expect(secondResult).toEqual({ ok: true, previousResponseStatus: "tentative" });
  });

  it("matches the self attendee case-insensitively", async () => {
    const userId = await createTestUser();
    const account = await createTestMailAccount(db, {
      userId,
      emailAddress: "Attendee@Example.com",
    });
    const calendarId = await createMirroredCalendar(userId, account.connectedAccountId);
    const seriesId = randomUUID();
    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, calendarId, {
        attendees: [{ email: "attendee@example.com", name: null, responseStatus: "needsAction" }],
      }),
    );

    expect(await answerInvitation(db, userId, seriesId, "declined")).toEqual({
      ok: true,
      previousResponseStatus: "needsAction",
    });
  });
});

describe("moveSeries (#238)", () => {
  it("copies the body and Overrides onto a fresh Series id on the destination Calendar, and trashes the source", async () => {
    const userId = await createTestUser();
    const fromCalendarId = await createCalendar(userId);
    const toCalendarId = await createCalendar(userId);
    const seriesId = randomUUID();
    const overrideId = randomUUID();
    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, fromCalendarId, {
        overrides: [
          {
            id: overrideId,
            originalStart: "2026-01-05T09:00:00.000Z",
            start: "2026-01-05T10:00:00.000Z",
            end: "2026-01-05T11:00:00.000Z",
            title: "Standup (moved)",
            location: null,
          },
        ],
      }),
    );
    const newSeriesId = randomUUID();

    const result = await moveSeries(db, userId, seriesId, newSeriesId, toCalendarId);

    expect(result).toEqual({ ok: true });
    const [sourceRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(sourceRow?.deletedAt).not.toBeNull();
    expect(await db.select().from(events).where(eq(events.seriesId, seriesId))).toHaveLength(0);

    const [destinationRow] = await db.select().from(series).where(eq(series.id, newSeriesId));
    expect(destinationRow).toMatchObject({
      calendarId: toCalendarId,
      title: "Standup",
      rrules: ["FREQ=WEEKLY"],
      upstreamId: null,
      etag: null,
    });
    expect(destinationRow?.uid).not.toBe(sourceRow?.uid);
    const destinationOverrides = await db
      .select()
      .from(overrides)
      .where(eq(overrides.seriesId, newSeriesId));
    expect(destinationOverrides).toHaveLength(1);
    expect(destinationOverrides[0]?.title).toBe("Standup (moved)");
    expect(await db.select().from(events).where(eq(events.seriesId, newSeriesId))).not.toHaveLength(
      0,
    );
  });

  it("rejects series_not_found for an id this User doesn't have", async () => {
    const userId = await createTestUser();
    const toCalendarId = await createCalendar(userId);
    expect(await moveSeries(db, userId, randomUUID(), randomUUID(), toCalendarId)).toEqual({
      ok: false,
      reason: "series_not_found",
    });
  });

  it("rejects calendar_not_found for a destination Calendar this User doesn't own", async () => {
    const userId = await createTestUser();
    const otherUserId = await createTestUser();
    const fromCalendarId = await createCalendar(userId);
    const toCalendarId = await createCalendar(otherUserId);
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, fromCalendarId));

    expect(await moveSeries(db, userId, seriesId, randomUUID(), toCalendarId)).toEqual({
      ok: false,
      reason: "calendar_not_found",
    });
  });

  it("hides — rejects — a cross-Connected-Account move", async () => {
    const userId = await createTestUser();
    const fromCalendarId = await createMirroredCalendar(userId);
    const toCalendarId = await createMirroredCalendar(userId); // A different account (default param).
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, fromCalendarId));

    const result = await moveSeries(db, userId, seriesId, randomUUID(), toCalendarId);

    expect(result).toEqual({ ok: false, reason: "cross_account_move_not_supported" });
    const [row] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(row?.deletedAt).toBeNull();
  });

  it("allows a move between two Calendars of the same Connected Account", async () => {
    const userId = await createTestUser();
    const accountId = randomUUID();
    const fromCalendarId = await createMirroredCalendar(userId, accountId);
    const toCalendarId = await createMirroredCalendar(userId, accountId);
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, fromCalendarId));
    const newSeriesId = randomUUID();

    expect(await moveSeries(db, userId, seriesId, newSeriesId, toCalendarId)).toEqual({ ok: true });
  });

  it("is a harmless no-op when the destination is already the current Calendar", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));

    expect(await moveSeries(db, userId, seriesId, randomUUID(), calendarId)).toEqual({ ok: true });
    const [row] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(row?.deletedAt).toBeNull();
  });

  it("enqueues a single 'move' outbox row, keyed to the destination Series, when either side is mirrored", async () => {
    const userId = await createTestUser();
    const fromCalendarId = await createMirroredCalendar(userId);
    const toCalendarId = await createCalendar(userId);
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, fromCalendarId));
    const newSeriesId = randomUUID();

    await moveSeries(db, userId, seriesId, newSeriesId, toCalendarId);

    const rows = await db
      .select()
      .from(calendarOutbox)
      .where(eq(calendarOutbox.seriesId, newSeriesId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: "move",
      moveFromSeriesId: seriesId,
      calendarId: toCalendarId,
    });
    expect(
      await db.select().from(calendarOutbox).where(eq(calendarOutbox.seriesId, seriesId)),
    ).toHaveLength(0);
  });

  it("enqueues no outbox row for a Local-to-Local move", async () => {
    const userId = await createTestUser();
    const fromCalendarId = await createCalendar(userId);
    const toCalendarId = await createCalendar(userId);
    const seriesId = randomUUID();
    await applySeriesSave(db, userId, saveFor(seriesId, fromCalendarId));
    const newSeriesId = randomUUID();

    await moveSeries(db, userId, seriesId, newSeriesId, toCalendarId);

    expect(
      await db.select().from(calendarOutbox).where(eq(calendarOutbox.seriesId, newSeriesId)),
    ).toHaveLength(0);
  });
});

describe("organiser-side iMIP (#242, ADR-0027)", () => {
  it("create sends a REQUEST to every Attendee at once, sequence 0", async () => {
    const userId = await createTestUser();
    const account = await createTestMailAccount(db, { userId });
    const calendarId = await createCalendarWithMailAccount(userId, account.id);
    const seriesId = randomUUID();

    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, calendarId, {
        attendees: [{ email: "bob@example.com", name: null, responseStatus: "needsAction" }],
      }),
    );

    const rows = await db.select().from(imipRequests).where(eq(imipRequests.seriesId, seriesId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      method: "REQUEST",
      attendeeAddress: "bob@example.com",
      organizerAddress: account.emailAddress,
      sequence: 0,
    });
    expect(rows[0]?.icsText).toContain("METHOD:REQUEST");

    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(seriesRow?.organizerFirstSentAt).not.toBeNull();
    expect(seriesRow?.sequence).toBe(0);
  });

  it("does not send anything for a create with no Attendees", async () => {
    const userId = await createTestUser();
    const account = await createTestMailAccount(db, { userId });
    const calendarId = await createCalendarWithMailAccount(userId, account.id);
    const seriesId = randomUUID();

    await applySeriesSave(db, userId, saveFor(seriesId, calendarId));

    expect(
      await db.select().from(imipRequests).where(eq(imipRequests.seriesId, seriesId)),
    ).toHaveLength(0);
    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(seriesRow?.organizerFirstSentAt).toBeNull();
  });

  it("does not send anything on a Calendar with no Mail Account", async () => {
    const userId = await createTestUser();
    const calendarId = await createCalendar(userId);
    const seriesId = randomUUID();

    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, calendarId, {
        attendees: [{ email: "bob@example.com", name: null, responseStatus: "needsAction" }],
      }),
    );

    expect(
      await db.select().from(imipRequests).where(eq(imipRequests.seriesId, seriesId)),
    ).toHaveLength(0);
  });

  it("a substantive edit bumps SEQUENCE and re-REQUESTs every current Attendee", async () => {
    const userId = await createTestUser();
    const account = await createTestMailAccount(db, { userId });
    const calendarId = await createCalendarWithMailAccount(userId, account.id);
    const seriesId = randomUUID();
    const attendees = [
      { email: "bob@example.com", name: null, responseStatus: "needsAction" as const },
    ];
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId, { attendees }));

    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, calendarId, { attendees, location: "Room 2", sendUpdate: true }),
    );

    const rows = await db.select().from(imipRequests).where(eq(imipRequests.seriesId, seriesId));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ method: "REQUEST", sequence: 1 });
    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(seriesRow?.sequence).toBe(1);
  });

  it("Don't send (sendUpdate: false) queues nothing for a substantive edit", async () => {
    const userId = await createTestUser();
    const account = await createTestMailAccount(db, { userId });
    const calendarId = await createCalendarWithMailAccount(userId, account.id);
    const seriesId = randomUUID();
    const attendees = [
      { email: "bob@example.com", name: null, responseStatus: "needsAction" as const },
    ];
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId, { attendees }));

    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, calendarId, { attendees, location: "Room 2", sendUpdate: false }),
    );

    const rows = await db.select().from(imipRequests).where(eq(imipRequests.seriesId, seriesId));
    expect(rows).toHaveLength(1); // Only the original create REQUEST.
    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(seriesRow?.sequence).toBe(0);
  });

  it("an added Attendee alone gets a REQUEST, unchanged Attendees don't", async () => {
    const userId = await createTestUser();
    const account = await createTestMailAccount(db, { userId });
    const calendarId = await createCalendarWithMailAccount(userId, account.id);
    const seriesId = randomUUID();
    const bob = { email: "bob@example.com", name: null, responseStatus: "needsAction" as const };
    const carol = {
      email: "carol@example.com",
      name: null,
      responseStatus: "needsAction" as const,
    };
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId, { attendees: [bob] }));

    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, calendarId, { attendees: [bob, carol], sendUpdate: true }),
    );

    const rows = await db.select().from(imipRequests).where(eq(imipRequests.seriesId, seriesId));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ method: "REQUEST", attendeeAddress: "carol@example.com" });
  });

  it("a removed Attendee alone gets a CANCEL, no REQUEST reissued to the rest", async () => {
    const userId = await createTestUser();
    const account = await createTestMailAccount(db, { userId });
    const calendarId = await createCalendarWithMailAccount(userId, account.id);
    const seriesId = randomUUID();
    const bob = { email: "bob@example.com", name: null, responseStatus: "needsAction" as const };
    const carol = {
      email: "carol@example.com",
      name: null,
      responseStatus: "needsAction" as const,
    };
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId, { attendees: [bob, carol] }));

    await applySeriesSave(
      db,
      userId,
      saveFor(seriesId, calendarId, { attendees: [bob], sendUpdate: true }),
    );

    const rows = await db.select().from(imipRequests).where(eq(imipRequests.seriesId, seriesId));
    expect(rows).toHaveLength(3); // The original REQUEST to bob and carol, plus the CANCEL to carol.
    expect(rows[2]).toMatchObject({ method: "CANCEL", attendeeAddress: "carol@example.com" });
  });

  it("trashSeries sends a CANCEL to every current Attendee", async () => {
    const userId = await createTestUser();
    const account = await createTestMailAccount(db, { userId });
    const calendarId = await createCalendarWithMailAccount(userId, account.id);
    const seriesId = randomUUID();
    const bob = { email: "bob@example.com", name: null, responseStatus: "needsAction" as const };
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId, { attendees: [bob] }));

    await trashSeries(db, userId, seriesId);

    const rows = await db.select().from(imipRequests).where(eq(imipRequests.seriesId, seriesId));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ method: "CANCEL", attendeeAddress: "bob@example.com" });
  });

  it("addExdate sends a CANCEL with a RECURRENCE-ID to every current Attendee", async () => {
    const userId = await createTestUser();
    const account = await createTestMailAccount(db, { userId });
    const calendarId = await createCalendarWithMailAccount(userId, account.id);
    const seriesId = randomUUID();
    const bob = { email: "bob@example.com", name: null, responseStatus: "needsAction" as const };
    await applySeriesSave(db, userId, saveFor(seriesId, calendarId, { attendees: [bob] }));
    const exdate = "2026-01-12T09:00:00.000Z";

    await addExdate(db, userId, seriesId, exdate);

    const rows = await db.select().from(imipRequests).where(eq(imipRequests.seriesId, seriesId));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ method: "CANCEL", recurrenceId: exdate });
    expect(rows[1]?.icsText).toContain("RECURRENCE-ID");
  });
});
