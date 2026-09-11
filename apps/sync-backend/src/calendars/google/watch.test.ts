import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { calendarMirrorSyncState, calendarWatchChannels } from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import { handleGoogleCalendarPushNotification, requestImmediatePoll } from "./watch.js";

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

describe("handleGoogleCalendarPushNotification", () => {
  it("requests an immediate poll for a channel's own Connected Account", async () => {
    await db.insert(calendarWatchChannels).values({
      channelId: "chan-1",
      resourceId: "res-1",
      connectedAccountId: "acct-1",
      expiration: new Date(Date.now() + 60_000),
    });

    await handleGoogleCalendarPushNotification(db, { channelId: "chan-1", resourceId: "res-1" });

    const [state] = await db
      .select()
      .from(calendarMirrorSyncState)
      .where(eq(calendarMirrorSyncState.connectedAccountId, "acct-1"));
    expect(state?.pollRequestedAt).not.toBeNull();
  });

  it("is a silent no-op for an unrecognized channel", async () => {
    await handleGoogleCalendarPushNotification(db, { channelId: "unknown", resourceId: "res-1" });
    const states = await db.select().from(calendarMirrorSyncState);
    expect(states).toHaveLength(0);
  });

  it("is a silent no-op when the resourceId doesn't match the channel's own", async () => {
    await db.insert(calendarWatchChannels).values({
      channelId: "chan-1",
      resourceId: "res-1",
      connectedAccountId: "acct-1",
      expiration: new Date(Date.now() + 60_000),
    });

    await handleGoogleCalendarPushNotification(db, { channelId: "chan-1", resourceId: "wrong" });

    const states = await db.select().from(calendarMirrorSyncState);
    expect(states).toHaveLength(0);
  });

  it("is a silent no-op for an already-expired channel", async () => {
    await db.insert(calendarWatchChannels).values({
      channelId: "chan-1",
      resourceId: "res-1",
      connectedAccountId: "acct-1",
      expiration: new Date(Date.now() - 60_000),
    });

    await handleGoogleCalendarPushNotification(db, { channelId: "chan-1", resourceId: "res-1" });

    const states = await db.select().from(calendarMirrorSyncState);
    expect(states).toHaveLength(0);
  });
});

describe("requestImmediatePoll", () => {
  it("stamps pollRequestedAt on a fresh row and again on an existing one", async () => {
    await requestImmediatePoll(db, "acct-1");
    const [first] = await db
      .select()
      .from(calendarMirrorSyncState)
      .where(eq(calendarMirrorSyncState.connectedAccountId, "acct-1"));
    expect(first?.pollRequestedAt).not.toBeNull();

    await requestImmediatePoll(db, "acct-1");
    const rows = await db
      .select()
      .from(calendarMirrorSyncState)
      .where(eq(calendarMirrorSyncState.connectedAccountId, "acct-1"));
    expect(rows).toHaveLength(1);
  });
});
