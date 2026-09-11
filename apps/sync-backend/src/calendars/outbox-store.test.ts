import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { type CalendarOutboxRow, calendarOutbox, calendars, series, users } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import {
  claimOutboxEntry,
  deleteOutboxEntry,
  dueOutboxCandidateIds,
  enqueueOutboxWrite,
  OUTBOX_DEADLINE_MS,
  outboxRetryDelayMs,
  releaseOutboxForReauth,
  scheduleOutboxRetry,
} from "./outbox-store.js";

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

async function createUser(): Promise<string> {
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
  const id = `gcal:${randomUUID()}:primary`;
  await db.insert(calendars).values({
    id,
    userId,
    name: "Mirrored",
    description: null,
    timeZone: "UTC",
    originType: "connectedAccount",
    connectedAccountId: randomUUID(),
    color: "#4285F4",
    isDefault: false,
    mailAccountId: null,
    mirrored: true,
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
  });
  return id;
}

async function createSeriesRow(
  userId: string,
  calendarId: string,
  etag: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await db.insert(series).values({
    id,
    userId,
    calendarId,
    uid: `${id}@test`,
    title: "Standup",
    allDay: false,
    floating: false,
    tzid: "UTC",
    dtstart: new Date("2026-01-05T09:00:00.000Z"),
    durationMs: 60 * 60 * 1000,
    transparency: "opaque",
    etag,
  });
  return id;
}

/** The one outbox row queued for a Series — asserted present, never `undefined`, since every case here enqueues exactly one before calling this. */
async function outboxRowFor(seriesId: string): Promise<CalendarOutboxRow> {
  const [row] = await db.select().from(calendarOutbox).where(eq(calendarOutbox.seriesId, seriesId));
  if (!row) throw new Error(`expected a queued outbox row for Series ${seriesId}`);
  return row;
}

async function outboxRowById(id: string): Promise<CalendarOutboxRow> {
  const [row] = await db.select().from(calendarOutbox).where(eq(calendarOutbox.id, id));
  if (!row) throw new Error(`expected outbox row ${id} to still exist`);
  return row;
}

describe("enqueueOutboxWrite", () => {
  it("inserts a fresh row carrying the Series' current etag as baseEtag", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, "etag-1");

    await enqueueOutboxWrite(db, {
      userId,
      calendarId,
      seriesId,
      operation: "upsert",
      sendInvitations: true,
    });

    const row = await outboxRowFor(seriesId);
    expect(row).toMatchObject({
      operation: "upsert",
      baseEtag: "etag-1",
      attempts: 0,
      sendInvitations: true,
    });
    expect(row.nextAttemptAt).toBeNull();
  });

  it("replaces (never duplicates) the queued row for the same Series — coalescing", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, "etag-1");

    await enqueueOutboxWrite(db, {
      userId,
      calendarId,
      seriesId,
      operation: "upsert",
      sendInvitations: true,
    });
    const first = await outboxRowFor(seriesId);

    await db.update(series).set({ etag: "etag-2" }).where(eq(series.id, seriesId));
    await enqueueOutboxWrite(db, {
      userId,
      calendarId,
      seriesId,
      operation: "cancel",
      sendInvitations: false,
    });

    const rows = await db
      .select()
      .from(calendarOutbox)
      .where(eq(calendarOutbox.seriesId, seriesId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id,
      operation: "cancel",
      baseEtag: "etag-2",
      sendInvitations: false,
    });
  });
});

describe("dueOutboxCandidateIds / claimOutboxEntry", () => {
  it("returns a row with no nextAttemptAt as due, and claiming bumps attempts and clears it", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    await enqueueOutboxWrite(db, {
      userId,
      calendarId,
      seriesId,
      operation: "upsert",
      sendInvitations: true,
    });

    const row = await outboxRowFor(seriesId);
    const ids = await dueOutboxCandidateIds(db);
    expect(ids).toContain(row.id);

    const claimed = await claimOutboxEntry(db, row.id);
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.nextAttemptAt).toBeNull();
  });

  it("does not return a row whose nextAttemptAt is in the future, and claiming it fails", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    await enqueueOutboxWrite(db, {
      userId,
      calendarId,
      seriesId,
      operation: "upsert",
      sendInvitations: true,
    });
    const row = await outboxRowFor(seriesId);

    const future = new Date(Date.now() + 60_000);
    await db
      .update(calendarOutbox)
      .set({ nextAttemptAt: future })
      .where(eq(calendarOutbox.id, row.id));

    expect(await dueOutboxCandidateIds(db)).not.toContain(row.id);
    expect(await claimOutboxEntry(db, row.id)).toBeNull();
  });
});

describe("scheduleOutboxRetry", () => {
  it("schedules a backoff retry before the deadline", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    const now = new Date();
    await enqueueOutboxWrite(
      db,
      { userId, calendarId, seriesId, operation: "upsert", sendInvitations: true },
      now,
    );
    const row = await outboxRowFor(seriesId);
    const claimed = await claimOutboxEntry(db, row.id, now);
    if (!claimed) throw new Error("expected a claim");

    const result = await scheduleOutboxRetry(db, claimed, "503 upstream unavailable", now);
    expect(result).toEqual({ expired: false });

    const updated = await outboxRowById(row.id);
    expect(updated.lastError).toBe("503 upstream unavailable");
    expect(updated.nextAttemptAt?.getTime()).toBe(now.getTime() + outboxRetryDelayMs(1));
  });

  it("reports expired once the 24-hour deadline has passed", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    const enqueuedAt = new Date("2026-01-01T00:00:00.000Z");
    await enqueueOutboxWrite(
      db,
      { userId, calendarId, seriesId, operation: "upsert", sendInvitations: true },
      enqueuedAt,
    );
    const row = await outboxRowFor(seriesId);
    const claimed = await claimOutboxEntry(db, row.id, enqueuedAt);
    if (!claimed) throw new Error("expected a claim");

    const afterDeadline = new Date(enqueuedAt.getTime() + OUTBOX_DEADLINE_MS + 1);
    const result = await scheduleOutboxRetry(db, claimed, "still failing", afterDeadline);
    expect(result).toEqual({ expired: true });
  });
});

describe("releaseOutboxForReauth", () => {
  it("rolls the just-taken attempt back without touching the deadline", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    await enqueueOutboxWrite(db, {
      userId,
      calendarId,
      seriesId,
      operation: "upsert",
      sendInvitations: true,
    });
    const row = await outboxRowFor(seriesId);
    const claimed = await claimOutboxEntry(db, row.id);
    if (!claimed) throw new Error("expected a claim");
    expect(claimed.attempts).toBe(1);

    await releaseOutboxForReauth(db, claimed);

    const after = await outboxRowById(row.id);
    expect(after.attempts).toBe(0);
    expect(after.nextAttemptAt).toBeNull();
    expect(after.deadline.getTime()).toBe(row.deadline.getTime());
  });
});

describe("deleteOutboxEntry", () => {
  it("removes the row", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    await enqueueOutboxWrite(db, {
      userId,
      calendarId,
      seriesId,
      operation: "upsert",
      sendInvitations: true,
    });
    const row = await outboxRowFor(seriesId);

    await deleteOutboxEntry(db, row.id);

    expect(
      await db.select().from(calendarOutbox).where(eq(calendarOutbox.id, row.id)),
    ).toHaveLength(0);
  });
});
