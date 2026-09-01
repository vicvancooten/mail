import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { getMailAccountById, markNeedsReauth, replaceMailAccountCredential } from "./store.js";

/**
 * `markNeedsReauth`'s atomic transition check (#53, ADR-0015): the Notifier
 * fires "once on entry and not again until reauth clears it", which depends
 * entirely on this function returning a row only on a genuine
 * `active -> needs_reauth` move — see its own doc comment.
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

describe("markNeedsReauth", () => {
  it("returns the updated row on a genuine transition into Needs Reauth", async () => {
    const account = await createTestMailAccount(db);
    const result = await markNeedsReauth(db, account.id);
    expect(result?.id).toBe(account.id);
    expect(result?.status).toBe("needs_reauth");
    expect((await getMailAccountById(db, account.id))?.status).toBe("needs_reauth");
  });

  it("returns null for a repeat call on an account already parked in Needs Reauth", async () => {
    const account = await createTestMailAccount(db);
    await markNeedsReauth(db, account.id);
    const second = await markNeedsReauth(db, account.id);
    expect(second).toBeNull();
  });

  it("fires again on a later, separate transition after reauth clears the first one", async () => {
    const account = await createTestMailAccount(db);
    await markNeedsReauth(db, account.id);
    await replaceMailAccountCredential(db, account.id, account.username, account.credential);
    const second = await markNeedsReauth(db, account.id);
    expect(second?.status).toBe("needs_reauth");
  });
});
