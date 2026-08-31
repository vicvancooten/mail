import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import {
  createSession,
  revokeAllSessionsForUser,
  revokeSession,
  SESSION_TTL_MS,
  validateSession,
} from "./sessions.js";

let db: Db;
let closeDb: () => Promise<void>;
let userId: string;

async function insertTestUser() {
  const [user] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      username: "vic",
      passwordHash: "not-checked-in-these-tests",
      role: "owner",
    })
    .returning();
  if (!user) throw new Error("insert returned no row");
  return user.id;
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  userId = await insertTestUser();
});

afterAll(async () => {
  await closeDb?.();
});

describe("createSession / validateSession", () => {
  it("validates a freshly created session and returns the owning user", async () => {
    const { token } = await createSession(db, userId);

    const result = await validateSession(db, token);

    expect(result?.user.id).toBe(userId);
    expect(result?.renewed).toBe(false);
  });

  it("rejects an unknown token", async () => {
    const result = await validateSession(db, "not-a-real-token");
    expect(result).toBeNull();
  });

  it("rejects an expired session", async () => {
    const { token } = await createSession(db, userId);
    // Force it into the past directly — no clock mocking needed.
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, userId));

    const result = await validateSession(db, token);
    expect(result).toBeNull();
  });

  it("slides the expiry forward once the session is stale", async () => {
    const { token, expiresAt: originalExpiry } = await createSession(db, userId);
    // Simulate a session last touched 2 days ago (past the 1-day renewal window).
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
      .where(eq(sessions.userId, userId));

    const result = await validateSession(db, token);

    expect(result?.renewed).toBe(true);
    expect(result?.expiresAt.getTime()).toBeGreaterThan(originalExpiry.getTime());
    expect(result?.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 5000);
  });
});

describe("revokeSession", () => {
  it("invalidates the session it revokes", async () => {
    const { token } = await createSession(db, userId);
    await revokeSession(db, token);

    expect(await validateSession(db, token)).toBeNull();
  });
});

describe("revokeAllSessionsForUser", () => {
  it("invalidates every session belonging to that user", async () => {
    const { token: tokenA } = await createSession(db, userId);
    const { token: tokenB } = await createSession(db, userId);

    await revokeAllSessionsForUser(db, userId);

    expect(await validateSession(db, tokenA)).toBeNull();
    expect(await validateSession(db, tokenB)).toBeNull();
  });
});
