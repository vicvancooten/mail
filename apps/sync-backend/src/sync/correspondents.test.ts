import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { correspondents, syncTombstones } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  activityForMessage,
  CORRESPONDENT_CAP,
  capCorrespondents,
  recordCorrespondentActivity,
} from "./correspondents.js";

/**
 * The Correspondent aggregate (#49) against a real Postgres: the ranking
 * math lives in a raw SQL upsert (`correspondents.ts`'s own doc comment
 * explains why), so its properties only exist at the database boundary.
 */
let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db);
});

afterAll(async () => {
  await closeDb?.();
});

describe("activityForMessage", () => {
  const base = {
    fromAddress: { name: "Ann", address: "ann@example.com" },
    toAddresses: [{ name: "Bo", address: "bo@example.com" }],
    ccAddresses: [{ name: null, address: "cc@example.com" }],
    sentAt: new Date("2026-01-01T00:00:00Z"),
    receivedAt: new Date("2026-01-01T01:00:00Z"),
  };

  it("counts a Sent-folder message's To/Cc as sent, deduplicated", () => {
    const activity = activityForMessage("sent", {
      ...base,
      toAddresses: [
        { name: "Bo", address: "bo@example.com" },
        { name: "Bo", address: "bo@example.com" },
      ],
    });
    expect(activity).toEqual([
      { address: "bo@example.com", name: "Bo", direction: "sent", at: base.sentAt },
      { address: "cc@example.com", name: null, direction: "sent", at: base.sentAt },
    ]);
  });

  it("counts an Inbox message's From as received", () => {
    expect(activityForMessage("inbox", base)).toEqual([
      { address: "ann@example.com", name: "Ann", direction: "received", at: base.receivedAt },
    ]);
  });

  it("counts a custom (null-role) folder's From as received too", () => {
    expect(activityForMessage(null, base)).toEqual([
      { address: "ann@example.com", name: "Ann", direction: "received", at: base.receivedAt },
    ]);
  });

  it("ignores Drafts, Trash and Junk", () => {
    expect(activityForMessage("drafts", base)).toEqual([]);
    expect(activityForMessage("trash", base)).toEqual([]);
    expect(activityForMessage("junk", base)).toEqual([]);
  });

  it("produces nothing for a Sent message with no recipients, or an Inbox message with no From", () => {
    expect(activityForMessage("sent", { ...base, toAddresses: [], ccAddresses: [] })).toEqual([]);
    expect(activityForMessage("inbox", { ...base, fromAddress: null })).toEqual([]);
  });
});

describe("recordCorrespondentActivity", () => {
  it("creates a Correspondent on first contact", async () => {
    await recordCorrespondentActivity(db, account.id, [
      {
        address: "Ann@Example.com",
        name: "Ann",
        direction: "received",
        at: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const [row] = await db
      .select()
      .from(correspondents)
      .where(eq(correspondents.mailAccountId, account.id));
    expect(row?.normalizedAddress).toBe("ann@example.com");
    expect(row?.address).toBe("Ann@Example.com");
    expect(row?.name).toBe("Ann");
    expect(row?.receivedCount).toBe(1);
    expect(row?.sentCount).toBe(0);
    expect(row?.score).toBeGreaterThan(0);
  });

  it("accumulates counts on the same normalized address rather than duplicating the row", async () => {
    const address = "bo@example.com";
    await recordCorrespondentActivity(db, account.id, [
      { address, name: "Bo", direction: "received", at: new Date("2026-01-01T00:00:00Z") },
    ]);
    await recordCorrespondentActivity(db, account.id, [
      {
        address: "BO@EXAMPLE.COM",
        name: "Bo",
        direction: "sent",
        at: new Date("2026-01-02T00:00:00Z"),
      },
    ]);

    const rows = await db
      .select()
      .from(correspondents)
      .where(eq(correspondents.mailAccountId, account.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sentCount).toBe(1);
    expect(rows[0]?.receivedCount).toBe(1);
    expect(rows[0]?.lastSeenAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("keeps the longest display name ever seen, never overwriting with null", async () => {
    await recordCorrespondentActivity(db, account.id, [
      { address: "cy@example.com", name: "Cy", direction: "received", at: new Date() },
    ]);
    await recordCorrespondentActivity(db, account.id, [
      { address: "cy@example.com", name: "Cy Chen", direction: "received", at: new Date() },
    ]);
    await recordCorrespondentActivity(db, account.id, [
      { address: "cy@example.com", name: null, direction: "received", at: new Date() },
    ]);

    const [row] = await db
      .select()
      .from(correspondents)
      .where(eq(correspondents.mailAccountId, account.id));
    expect(row?.name).toBe("Cy Chen");
  });

  it("ranks a frequently-mailed address above a frequently-received one (sent-weight ≫ received-weight)", async () => {
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      await recordCorrespondentActivity(db, account.id, [
        { address: "sent-to@example.com", name: null, direction: "sent", at: now },
      ]);
    }
    for (let i = 0; i < 3; i++) {
      await recordCorrespondentActivity(db, account.id, [
        { address: "received-from@example.com", name: null, direction: "received", at: now },
      ]);
    }

    const rows = await db
      .select()
      .from(correspondents)
      .where(eq(correspondents.mailAccountId, account.id));
    const sent = rows.find((row) => row.normalizedAddress === "sent-to@example.com");
    const received = rows.find((row) => row.normalizedAddress === "received-from@example.com");
    expect(sent?.score ?? 0).toBeGreaterThan(received?.score ?? 0);
  });

  it("scores a stale contact lower than an equally-frequent recent one (recency decay)", async () => {
    const longAgo = new Date();
    longAgo.setDate(longAgo.getDate() - 400);
    await recordCorrespondentActivity(db, account.id, [
      { address: "stale@example.com", name: null, direction: "sent", at: longAgo },
    ]);
    await recordCorrespondentActivity(db, account.id, [
      { address: "fresh@example.com", name: null, direction: "sent", at: new Date() },
    ]);

    const rows = await db
      .select()
      .from(correspondents)
      .where(eq(correspondents.mailAccountId, account.id));
    const stale = rows.find((row) => row.normalizedAddress === "stale@example.com");
    const fresh = rows.find((row) => row.normalizedAddress === "fresh@example.com");
    expect(fresh?.score ?? 0).toBeGreaterThan(stale?.score ?? 0);
  });
});

describe("capCorrespondents", () => {
  it("prunes back to the top ~500 by score, tombstoning what it removes", async () => {
    const now = new Date();
    const total = CORRESPONDENT_CAP + 150;
    // One contact each, staggered a day apart — recency decay alone gives
    // `c0` (oldest) the worst score and `c{total-1}` (mailed today) the best,
    // so which addresses survive the prune is deterministic.
    for (let i = 0; i < total; i++) {
      const at = new Date(now);
      at.setDate(at.getDate() - (total - i));
      await recordCorrespondentActivity(db, account.id, [
        { address: `c${i}@example.com`, name: null, direction: "sent", at },
      ]);
    }

    await capCorrespondents(db, account.id);

    const rows = await db
      .select()
      .from(correspondents)
      .where(eq(correspondents.mailAccountId, account.id));
    expect(rows).toHaveLength(CORRESPONDENT_CAP);
    // The worst-scoring (lowest-index) addresses are the ones pruned.
    expect(rows.some((row) => row.normalizedAddress === "c0@example.com")).toBe(false);
    expect(rows.some((row) => row.normalizedAddress === `c${total - 1}@example.com`)).toBe(true);

    const tombstones = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.mailAccountId, account.id));
    expect(tombstones).toHaveLength(total - CORRESPONDENT_CAP);
    expect(tombstones.every((row) => row.collection === "Correspondent")).toBe(true);
  });

  it("does nothing while still within the cap plus slack", async () => {
    await recordCorrespondentActivity(db, account.id, [
      { address: "solo@example.com", name: null, direction: "received", at: new Date() },
    ]);
    await capCorrespondents(db, account.id);

    const rows = await db
      .select()
      .from(correspondents)
      .where(eq(correspondents.mailAccountId, account.id));
    expect(rows).toHaveLength(1);
  });
});
