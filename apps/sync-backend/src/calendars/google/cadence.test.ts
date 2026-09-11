import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { sessions, users } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import {
  CALENDAR_ACTIVE_POLL_INTERVAL_MS,
  CALENDAR_IDLE_POLL_INTERVAL_MS,
  calendarEventPollIntervalMs,
  wasClientActiveRecently,
} from "./cadence.js";

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

describe("wasClientActiveRecently", () => {
  it("is false for a User with no session at all", async () => {
    const userId = await createTestUser();
    expect(await wasClientActiveRecently(db, userId)).toBe(false);
  });

  it("is true when a session's lastSeenAt falls within the last 24 hours", async () => {
    const userId = await createTestUser();
    const now = new Date("2026-06-01T12:00:00Z");
    await db.insert(sessions).values({
      id: randomUUID(),
      userId,
      expiresAt: new Date(now.getTime() + 1000),
      lastSeenAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    expect(await wasClientActiveRecently(db, userId, now)).toBe(true);
  });

  it("is false once every session's lastSeenAt is more than 24 hours old", async () => {
    const userId = await createTestUser();
    const now = new Date("2026-06-01T12:00:00Z");
    await db.insert(sessions).values({
      id: randomUUID(),
      userId,
      expiresAt: new Date(now.getTime() + 1000),
      lastSeenAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
    });
    expect(await wasClientActiveRecently(db, userId, now)).toBe(false);
  });
});

describe("calendarEventPollIntervalMs", () => {
  it("is the 5-minute active interval when a session was recently seen", async () => {
    const userId = await createTestUser();
    const now = new Date();
    await db.insert(sessions).values({
      id: randomUUID(),
      userId,
      expiresAt: new Date(now.getTime() + 1000),
      lastSeenAt: now,
    });
    expect(await calendarEventPollIntervalMs(db, userId, now)).toBe(
      CALENDAR_ACTIVE_POLL_INTERVAL_MS,
    );
  });

  it("is the 30-minute idle interval otherwise", async () => {
    const userId = await createTestUser();
    expect(await calendarEventPollIntervalMs(db, userId)).toBe(CALENDAR_IDLE_POLL_INTERVAL_MS);
  });
});
