import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { calendars, series, users } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { purgeExpiredSeries } from "./series-purge.js";

/**
 * `series-purge.ts`'s sweep (#233) against a real Postgres — `note-purge
 * .test.ts`'s own reasoning: the 24-hour boundary only exists at the
 * database boundary.
 */
let db: Db;
let closeDb: () => Promise<void>;
let userId: string;
let calendarId: string;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    username: `user-${userId.slice(0, 8)}`,
    passwordHash: "not-a-real-hash",
    role: "owner",
  });
  calendarId = `local:${randomUUID()}`;
  await db.insert(calendars).values({
    id: calendarId,
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
});

afterAll(async () => {
  await closeDb?.();
});

async function seedSeries(deletedAt: Date | null): Promise<string> {
  const id = randomUUID();
  await db.insert(series).values({
    id,
    userId,
    calendarId,
    uid: `${id}@test`,
    title: "Standup",
    allDay: false,
    floating: false,
    dtstart: new Date("2026-01-05T09:00:00Z"),
    durationMs: 60 * 60 * 1000,
    transparency: "opaque",
    deletedAt,
  });
  return id;
}

describe("purgeExpiredSeries", () => {
  it("purges a Series whose deletedAt is past the 24-hour retention window", async () => {
    const now = new Date("2026-06-30T12:00:00Z");
    const seriesId = await seedSeries(new Date("2026-06-29T11:59:59Z"));

    const purged = await purgeExpiredSeries(db, now);

    expect(purged).toBe(1);
    expect(await db.select().from(series).where(eq(series.id, seriesId))).toHaveLength(0);
  });

  it("purges exactly at the 24-hour boundary (<=, not <)", async () => {
    const now = new Date("2026-06-30T12:00:00Z");
    const seriesId = await seedSeries(new Date("2026-06-29T12:00:00Z"));

    const purged = await purgeExpiredSeries(db, now);

    expect(purged).toBe(1);
    expect(await db.select().from(series).where(eq(series.id, seriesId))).toHaveLength(0);
  });

  it("leaves a Series still inside its 24-hour window untouched", async () => {
    const now = new Date("2026-06-30T12:00:00Z");
    const seriesId = await seedSeries(new Date("2026-06-29T12:00:01Z"));

    const purged = await purgeExpiredSeries(db, now);

    expect(purged).toBe(0);
    expect(await db.select().from(series).where(eq(series.id, seriesId))).toHaveLength(1);
  });

  it("leaves an ordinary, never-deleted Series untouched", async () => {
    const seriesId = await seedSeries(null);

    const purged = await purgeExpiredSeries(db, new Date("2026-12-31T00:00:00Z"));

    expect(purged).toBe(0);
    expect(await db.select().from(series).where(eq(series.id, seriesId))).toHaveLength(1);
  });
});
