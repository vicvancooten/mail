import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import {
  type CalendarOutboxRow,
  calendarOutbox,
  calendars,
  rollbacks,
  type SeriesRow,
  series,
  users,
} from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import { enqueueOutboxWrite } from "../outbox-store.js";
import { type GraphCalendarClient, GraphCalendarWriteError, type GraphEvent } from "./client.js";
import { processGraphOutboxEntry } from "./outbox-processor.js";

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

const CONNECTED_ACCOUNT_ID = "acct-1";

async function createCalendar(userId: string): Promise<string> {
  const id = `gcal-ms:${CONNECTED_ACCOUNT_ID}:primary`;
  await db.insert(calendars).values({
    id,
    userId,
    name: "Mirrored",
    description: null,
    timeZone: "UTC",
    originType: "connectedAccount",
    connectedAccountId: CONNECTED_ACCOUNT_ID,
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
  patch: Partial<{
    upstreamId: string | null;
    etag: string | null;
    upstreamSnapshot: Record<string, unknown> | null;
    rrules: string[];
  }> = {},
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
    rrules: patch.rrules ?? [],
    upstreamId: patch.upstreamId ?? null,
    etag: patch.etag ?? null,
    upstreamSnapshot: patch.upstreamSnapshot,
  });
  return id;
}

function fakeClient(overrides: Partial<GraphCalendarClient> = {}): GraphCalendarClient {
  return {
    listCalendars: async () => [],
    getMailboxTimeZone: async () => "UTC",
    listCalendarViewDeltaPage: async () => ({ items: [] }),
    insertEvent: async () => {
      throw new Error("insertEvent not stubbed");
    },
    getEvent: async () => {
      throw new Error("getEvent not stubbed");
    },
    patchEvent: async () => {
      throw new Error("patchEvent not stubbed");
    },
    cancelEvent: async () => {
      throw new Error("cancelEvent not stubbed");
    },
    respondToEvent: async () => {
      throw new Error("respondToEvent not stubbed");
    },
    patchCalendar: async () => {
      throw new Error("patchCalendar not stubbed");
    },
    ...overrides,
  };
}

async function enqueueAndFetchRow(params: {
  userId: string;
  calendarId: string;
  seriesId: string;
  operation: "upsert" | "cancel" | "restore" | "respond";
  responseStatus?: "needsAction" | "accepted" | "declined" | "tentative";
}): Promise<CalendarOutboxRow> {
  await enqueueOutboxWrite(db, { ...params, sendInvitations: true });
  return outboxRowFor(params.seriesId);
}

async function outboxRowFor(seriesId: string): Promise<CalendarOutboxRow> {
  const [row] = await db.select().from(calendarOutbox).where(eq(calendarOutbox.seriesId, seriesId));
  if (!row) throw new Error(`expected a queued outbox row for Series ${seriesId}`);
  return row;
}

async function outboxRowById(id: string): Promise<CalendarOutboxRow | undefined> {
  const [row] = await db.select().from(calendarOutbox).where(eq(calendarOutbox.id, id));
  return row;
}

async function seriesRowFor(seriesId: string): Promise<SeriesRow> {
  const [row] = await db.select().from(series).where(eq(series.id, seriesId));
  if (!row) throw new Error(`expected a Series row for ${seriesId}`);
  return row;
}

const GRAPH_EVENT: GraphEvent = { id: "evt-1", changeKey: "ck-1" };

/** A fully-populated `upstreamSnapshot` — `revertSeriesFromUpstreamSnapshot` reads every one of these fields with no defaults, so a reject-path test's fixture must supply all of them, matching `createSeriesRow`'s own dtstart/duration. */
function fullSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Original title",
    description: null,
    location: null,
    allDay: false,
    floating: false,
    tzid: "UTC",
    dtstart: "2026-01-05T09:00:00.000Z",
    durationMs: 60 * 60 * 1000,
    rrules: [],
    rdates: [],
    exdates: [],
    transparency: "opaque",
    attendees: [],
    upstreamId: "evt-1",
    etag: "ck-1",
    ...overrides,
  };
}

describe("processGraphOutboxEntry — operation: 'respond' (#240)", () => {
  it("calls the accept action for an 'accepted' Answer, touching neither upstreamId nor etag", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: "evt-1",
      etag: "ck-1",
    });
    const row = await enqueueAndFetchRow({
      userId,
      calendarId,
      seriesId,
      operation: "respond",
      responseStatus: "accepted",
    });

    let respondCalled: { eventId: string; response: string } | undefined;
    const client = fakeClient({
      respondToEvent: async (_token, eventId, response) => {
        respondCalled = { eventId, response };
      },
    });

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "tok" });

    expect(respondCalled).toEqual({ eventId: "evt-1", response: "accept" });
    const seriesAfter = await seriesRowFor(seriesId);
    expect(seriesAfter.upstreamId).toBe("evt-1");
    expect(seriesAfter.etag).toBe("ck-1");
    expect(await outboxRowById(row.id)).toBeUndefined();
  });

  it("maps 'declined' to decline and 'tentative' to tentativelyAccept", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);

    for (const [responseStatus, expectedAction] of [
      ["declined", "decline"],
      ["tentative", "tentativelyAccept"],
    ] as const) {
      const seriesId = await createSeriesRow(userId, calendarId, {
        upstreamId: "evt-1",
        etag: "ck-1",
      });
      const row = await enqueueAndFetchRow({
        userId,
        calendarId,
        seriesId,
        operation: "respond",
        responseStatus,
      });
      let calledWith: string | undefined;
      const client = fakeClient({
        respondToEvent: async (_token, _eventId, response) => {
          calledWith = response;
        },
      });
      await processGraphOutboxEntry(db, row.id, { client, accessToken: "tok" });
      expect(calledWith).toBe(expectedAction);
    }
  });

  it("is a no-op when the Series was never pushed upstream at all", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId); // no upstreamId
    const row = await enqueueAndFetchRow({
      userId,
      calendarId,
      seriesId,
      operation: "respond",
      responseStatus: "accepted",
    });

    const client = fakeClient({
      respondToEvent: async () => {
        throw new Error("should not be called with no upstreamId");
      },
    });

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "tok" });
    expect(await outboxRowById(row.id)).toBeUndefined();
  });
});

describe("processGraphOutboxEntry", () => {
  it("inserts a fresh event for an upsert with no upstreamId, then snapshots the result", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    let insertCalled = false;
    const client = fakeClient({
      insertEvent: async () => {
        insertCalled = true;
        return GRAPH_EVENT;
      },
    });

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "t" });

    expect(insertCalled).toBe(true);
    expect(await outboxRowById(row.id)).toBeUndefined();
    const seriesRow = await seriesRowFor(seriesId);
    expect(seriesRow.upstreamId).toBe("evt-1");
    expect(seriesRow.etag).toBe("ck-1");
  });

  it("compares changeKey via getEvent before patchEvent, proceeding when it still matches", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: "evt-1",
      etag: "ck-1",
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    let patchCalled = false;
    const client = fakeClient({
      getEvent: async () => ({ ...GRAPH_EVENT, changeKey: "ck-1" }),
      patchEvent: async () => {
        patchCalled = true;
        return { ...GRAPH_EVENT, changeKey: "ck-2" };
      },
    });

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "t" });

    expect(patchCalled).toBe(true);
    const seriesRow = await seriesRowFor(seriesId);
    expect(seriesRow.etag).toBe("ck-2");
  });

  it("rejects (never PATCHing) when the pre-write changeKey compare finds Graph's copy has moved", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: "evt-1",
      etag: "ck-1",
      upstreamSnapshot: fullSnapshot(),
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    let patchCalled = false;
    const client = fakeClient({
      getEvent: async () => ({ ...GRAPH_EVENT, changeKey: "ck-moved" }),
      patchEvent: async () => {
        patchCalled = true;
        return GRAPH_EVENT;
      },
    });

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "t" });

    expect(patchCalled).toBe(false);
    expect(await outboxRowById(row.id)).toBeUndefined();
    expect(await db.select().from(rollbacks)).toHaveLength(1);
  });

  it("rejects without any network call when the outbox row's own baseEtag already lagged the Series' etag (conflict shape 3)", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: "evt-1",
      etag: "ck-2",
      upstreamSnapshot: fullSnapshot({ etag: "ck-1" }),
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });
    // Simulate the row having been enqueued against a now-stale etag.
    await db.update(calendarOutbox).set({ baseEtag: "ck-1" }).where(eq(calendarOutbox.id, row.id));

    const client = fakeClient(); // every method throws if called

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "t" });

    expect(await outboxRowById(row.id)).toBeUndefined();
    expect(await db.select().from(rollbacks)).toHaveLength(1);
  });

  it("cancels via the cancel action, clearing upstreamId/etag since Graph deletes the event outright", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: "evt-1",
      etag: "ck-1",
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "cancel" });

    let cancelledId: string | undefined;
    const client = fakeClient({
      cancelEvent: async (_token, eventId) => {
        cancelledId = eventId;
      },
    });

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "t" });

    expect(cancelledId).toBe("evt-1");
    const seriesRow = await seriesRowFor(seriesId);
    expect(seriesRow.upstreamId).toBeNull();
    expect(seriesRow.etag).toBeNull();
  });

  it("no-ops a cancel for a Series never pushed upstream at all", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "cancel" });

    const client = fakeClient(); // cancelEvent throws if called

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "t" });

    expect(await outboxRowById(row.id)).toBeUndefined();
  });

  it("restores by always inserting a fresh event, never PATCHing, even with a stale upstreamId", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: "evt-old",
      etag: "ck-old",
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "restore" });

    let insertCalled = false;
    const client = fakeClient({
      insertEvent: async () => {
        insertCalled = true;
        return { id: "evt-new", changeKey: "ck-new" };
      },
      patchEvent: async () => {
        throw new Error("restore must never PATCH on Graph");
      },
    });

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "t" });

    expect(insertCalled).toBe(true);
    const seriesRow = await seriesRowFor(seriesId);
    expect(seriesRow.upstreamId).toBe("evt-new");
  });

  it("rejects an untranslatable recurrence with no network call at all", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      rrules: ["FREQ=DAILY;INTERVAL=2"],
      upstreamSnapshot: fullSnapshot(),
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    const client = fakeClient(); // every method throws if called

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "t" });

    expect(await outboxRowById(row.id)).toBeUndefined();
    expect(await db.select().from(rollbacks)).toHaveLength(1);
  });

  it("releases (not rejects) for reauth, holding the row for the next tick", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    const client = fakeClient({
      insertEvent: async () => {
        throw new GraphCalendarWriteError("needsReauth", 401, "expired");
      },
    });

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "t" });

    const remaining = await outboxRowById(row.id);
    expect(remaining).toBeDefined();
    expect(remaining?.attempts).toBe(0);
  });

  it("schedules a retry for a transient failure rather than rejecting immediately", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    const client = fakeClient({
      insertEvent: async () => {
        throw new GraphCalendarWriteError("transient", 503, "unavailable");
      },
    });

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "t" });

    const remaining = await outboxRowById(row.id);
    expect(remaining).toBeDefined();
    expect(remaining?.nextAttemptAt).not.toBeNull();
    expect(await db.select().from(rollbacks)).toHaveLength(0);
  });

  it("rejects a permanent write error", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamSnapshot: fullSnapshot(),
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    const client = fakeClient({
      insertEvent: async () => {
        throw new GraphCalendarWriteError("permanent", 400, "malformed");
      },
    });

    await processGraphOutboxEntry(db, row.id, { client, accessToken: "t" });

    expect(await outboxRowById(row.id)).toBeUndefined();
    expect(await db.select().from(rollbacks)).toHaveLength(1);
  });
});
