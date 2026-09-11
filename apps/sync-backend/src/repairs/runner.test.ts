import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { repairs } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { type Repair, runRepairs } from "./runner.js";

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

describe("runRepairs", () => {
  it("runs a repair that hasn't recorded yet, and records it", async () => {
    let calls = 0;
    const repair: Repair = {
      name: "test-repair",
      run: async () => {
        calls++;
      },
    };

    await runRepairs(db, [repair]);

    expect(calls).toBe(1);
    const [record] = await db.select().from(repairs).where(eq(repairs.id, "test-repair"));
    expect(record).toBeDefined();
  });

  it("never runs a repair twice", async () => {
    let calls = 0;
    const repair: Repair = {
      name: "test-repair",
      run: async () => {
        calls++;
      },
    };

    await runRepairs(db, [repair]);
    await runRepairs(db, [repair]);

    expect(calls).toBe(1);
  });

  it("leaves nothing recorded when the repair throws, so the next boot retries it", async () => {
    let calls = 0;
    const repair: Repair = {
      name: "test-repair",
      run: async () => {
        calls++;
        throw new Error("boom");
      },
    };

    await expect(runRepairs(db, [repair])).rejects.toThrow("boom");

    const [record] = await db.select().from(repairs).where(eq(repairs.id, "test-repair"));
    expect(record).toBeUndefined();

    // A retried boot runs it again, exactly as if it had never started.
    await expect(runRepairs(db, [repair])).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });

  it("runs a later repair even when an earlier one already recorded", async () => {
    const first: Repair = { name: "first", run: async () => {} };
    await runRepairs(db, [first]);

    let secondRan = false;
    const second: Repair = {
      name: "second",
      run: async () => {
        secondRan = true;
      },
    };
    await runRepairs(db, [first, second]);

    expect(secondRan).toBe(true);
  });
});
