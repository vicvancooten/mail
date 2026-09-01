import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { syncMailAccountCollection, syncThreadCollection } from "./collection-sync.js";
import { decodeSyncToken } from "./sync-tokens.js";

/**
 * `buildDelta`'s bootstrap edge case, exercised through its two thinnest
 * callers (`syncMailAccountCollection`, User-scoped with no windowing;
 * `syncThreadCollection`, per Mail Account with an epoch): a genuine
 * bootstrap (`token === null`) must still hand back a delta carrying
 * `newState` even when there is nothing to return, so the Client has a
 * token to persist — the only thing that lets it tell "I bootstrapped and
 * got nothing" from "I haven't asked yet". Only a *resumed* poll
 * (`token` already set) with nothing new collapses to `null`.
 */
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

describe("syncMailAccountCollection — the bootstrap-empty edge case", () => {
  it("returns a delta carrying newState on a bootstrap even with zero Mail Accounts", async () => {
    const userId = await createTestUser();

    const result = await syncMailAccountCollection(db, userId, null);

    expect(result).not.toBeNull();
    expect(result?.created).toEqual([]);
    expect(result?.updated).toEqual([]);
    expect(result?.destroyed).toEqual([]);
    expect(result?.hasMore).toBe(false);
    expect(result?.reset).toBeUndefined();
    expect(typeof result?.newState).toBe("string");
    expect(decodeSyncToken(result?.newState ?? "")).not.toBeNull();
  });

  it("returns null on a resumed poll with an existing token and nothing new", async () => {
    const userId = await createTestUser();
    const bootstrap = await syncMailAccountCollection(db, userId, null);
    expect(bootstrap).not.toBeNull();

    const result = await syncMailAccountCollection(db, userId, bootstrap?.newState ?? null);

    expect(result).toBeNull();
  });

  it("still returns real content on a bootstrap that has Mail Accounts", async () => {
    const account = await createTestMailAccount(db);

    const result = await syncMailAccountCollection(db, account.userId, null);

    expect(result).not.toBeNull();
    expect(result?.created.map((row) => row.id)).toEqual([account.id]);
  });
});

describe("syncThreadCollection — the bootstrap-empty edge case", () => {
  it("returns a delta carrying newState on a bootstrap even with zero Threads", async () => {
    const account = await createTestMailAccount(db);

    const result = await syncThreadCollection(db, account.id, account.threadsEpoch, null);

    expect(result).not.toBeNull();
    expect(result?.created).toEqual([]);
    expect(result?.hasMore).toBe(false);
    expect(typeof result?.newState).toBe("string");
  });

  it("returns null on a resumed poll with an existing token and no new Threads", async () => {
    const account = await createTestMailAccount(db);
    const bootstrap = await syncThreadCollection(db, account.id, account.threadsEpoch, null);
    expect(bootstrap).not.toBeNull();

    const result = await syncThreadCollection(
      db,
      account.id,
      account.threadsEpoch,
      bootstrap?.newState ?? null,
    );

    expect(result).toBeNull();
  });
});
