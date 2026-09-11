import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { rollbacks, syncTombstones, users } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { purgeExpiredRollbacks, ROLLBACK_RETENTION_MS } from "./rollback-purge.js";

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

async function createRollback(userId: string, occurredAt: Date): Promise<string> {
  const id = randomUUID();
  await db.insert(rollbacks).values({
    id,
    userId,
    collection: "Series",
    entityId: randomUUID(),
    reason: "rejected",
    occurredAt,
  });
  return id;
}

describe("purgeExpiredRollbacks", () => {
  it("leaves a Rollback younger than 7 days untouched", async () => {
    const userId = await createUser();
    const now = new Date("2026-02-01T00:00:00.000Z");
    const id = await createRollback(
      userId,
      new Date(now.getTime() - ROLLBACK_RETENTION_MS + 60_000),
    );

    const purged = await purgeExpiredRollbacks(db, now);

    expect(purged).toBe(0);
    expect(await db.select().from(rollbacks).where(eq(rollbacks.id, id))).toHaveLength(1);
  });

  it("deletes a Rollback past 7 days and tombstones it", async () => {
    const userId = await createUser();
    const now = new Date("2026-02-01T00:00:00.000Z");
    const id = await createRollback(
      userId,
      new Date(now.getTime() - ROLLBACK_RETENTION_MS - 60_000),
    );

    const purged = await purgeExpiredRollbacks(db, now);

    expect(purged).toBe(1);
    expect(await db.select().from(rollbacks).where(eq(rollbacks.id, id))).toHaveLength(0);
    const tombstones = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.entityId, id));
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.collection).toBe("Rollback");
  });
});
