import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  type CalendarOutboxRow,
  calendarOutbox,
  calendars,
  rollbacks,
  type SeriesRow,
  series,
  users,
} from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import type {
  GoogleCalendarClient,
  GoogleEvent,
  InsertEventParams,
  PatchEventParams,
} from "./google/client.js";
import { GoogleCalendarWriteError } from "./google/client.js";
import { processOutboxEntry } from "./outbox-processor.js";
import { enqueueOutboxWrite } from "./outbox-store.js";

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

async function createCalendar(
  userId: string,
  googleCalendarId = "primary",
  connectedAccountId = CONNECTED_ACCOUNT_ID,
): Promise<string> {
  const id = `gcal:${connectedAccountId}:${googleCalendarId}`;
  await db.insert(calendars).values({
    id,
    userId,
    name: "Mirrored",
    description: null,
    timeZone: "UTC",
    originType: "connectedAccount",
    connectedAccountId,
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
    deletedAt: Date | null;
    attendees: SeriesRow["attendees"];
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
    attendees: patch.attendees ?? [],
    upstreamId: patch.upstreamId ?? null,
    etag: patch.etag ?? null,
    upstreamSnapshot: patch.upstreamSnapshot,
    deletedAt: patch.deletedAt ?? null,
  });
  return id;
}

function fakeClient(overrides: Partial<GoogleCalendarClient> = {}): GoogleCalendarClient {
  return {
    listCalendarList: async () => [],
    getCalendar: async () => {
      throw new Error("not used");
    },
    listEventsPage: async () => ({ items: [] }),
    insertEvent: async () => {
      throw new Error("insertEvent not stubbed");
    },
    patchEvent: async () => {
      throw new Error("patchEvent not stubbed");
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
  if (!row) throw new Error(`expected Series ${seriesId} to still exist`);
  return row;
}

describe("processOutboxEntry", () => {
  it("inserts a fresh event when the Series has never been pushed, and stores the returned id/etag", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    let insertCalled: InsertEventParams | undefined;
    const client = fakeClient({
      insertEvent: async (_token, _calId, params) => {
        insertCalled = params;
        return { id: "g-event-1", status: "confirmed", etag: "etag-a" } satisfies GoogleEvent;
      },
    });

    await processOutboxEntry(db, row.id, { client, accessToken: "tok" });

    expect(insertCalled?.sendUpdates).toBe("all");
    const seriesAfter = await seriesRowFor(seriesId);
    expect(seriesAfter.upstreamId).toBe("g-event-1");
    expect(seriesAfter.etag).toBe("etag-a");
    expect(seriesAfter.upstreamSnapshot).toMatchObject({
      title: "Standup",
      upstreamId: "g-event-1",
    });
    expect(
      await db.select().from(calendarOutbox).where(eq(calendarOutbox.id, row.id)),
    ).toHaveLength(0);
  });

  it("operation 'respond' (#240) patches the whole event, carrying the just-answered responseStatus", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: "g-1",
      etag: "etag-a",
      attendees: [{ email: "me@example.com", name: null, responseStatus: "accepted" }],
    });
    const row = await enqueueAndFetchRow({
      userId,
      calendarId,
      seriesId,
      operation: "respond",
      responseStatus: "accepted",
    });

    let patchCalled: PatchEventParams | undefined;
    const client = fakeClient({
      patchEvent: async (_token, _calId, _eventId, params) => {
        patchCalled = params;
        return { id: "g-1", status: "confirmed", etag: "etag-b" } satisfies GoogleEvent;
      },
    });

    await processOutboxEntry(db, row.id, { client, accessToken: "tok" });

    expect(patchCalled?.body.attendees).toEqual([
      { email: "me@example.com", displayName: undefined, responseStatus: "accepted" },
    ]);
  });

  it("patches conditionally on the Series' etag when one already exists upstream", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: "g-1",
      etag: "etag-a",
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    let patchCalled: PatchEventParams | undefined;
    const client = fakeClient({
      patchEvent: async (_token, _calId, eventId, params) => {
        expect(eventId).toBe("g-1");
        patchCalled = params;
        return { id: "g-1", status: "confirmed", etag: "etag-b" };
      },
    });

    await processOutboxEntry(db, row.id, { client, accessToken: "tok" });

    expect(patchCalled?.ifMatchEtag).toBe("etag-a");
    const seriesAfter = await seriesRowFor(seriesId);
    expect(seriesAfter.etag).toBe("etag-b");
  });

  it("restore is a status flip (patchEvent), never insertEvent, when an upstream id already exists", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: "g-1",
      etag: "etag-a",
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "restore" });

    let patchedStatus: string | undefined;
    const client = fakeClient({
      insertEvent: async () => {
        throw new Error("must not create afresh on restore");
      },
      patchEvent: async (_t, _c, _id, params) => {
        patchedStatus = params.body.status;
        return { id: "g-1", status: "confirmed", etag: "etag-c" };
      },
    });

    await processOutboxEntry(db, row.id, { client, accessToken: "tok" });
    expect(patchedStatus).toBe("confirmed");
  });

  it("a conflict shape 3 (etag already moved) reverts from upstreamSnapshot and writes a Rollback, with no network call", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: "g-1",
      etag: "etag-b", // moved since baseEtag was captured
      upstreamSnapshot: {
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
        upstreamId: "g-1",
        etag: "etag-a",
      },
    });
    // Enqueue while etag was still "etag-a" (baseEtag), then simulate a
    // read-mirror moving it to "etag-b" before this push ever runs.
    await enqueueOutboxWrite(db, {
      userId,
      calendarId,
      seriesId,
      operation: "upsert",
      sendInvitations: true,
    });
    await db
      .update(calendarOutbox)
      .set({ baseEtag: "etag-a" })
      .where(eq(calendarOutbox.seriesId, seriesId));
    const row = await outboxRowFor(seriesId);

    let networkCalled = false;
    const client = fakeClient({
      insertEvent: async () => {
        networkCalled = true;
        throw new Error("should not be called");
      },
      patchEvent: async () => {
        networkCalled = true;
        throw new Error("should not be called");
      },
    });

    await processOutboxEntry(db, row.id, { client, accessToken: "tok" });

    expect(networkCalled).toBe(false);
    const seriesAfter = await seriesRowFor(seriesId);
    expect(seriesAfter.title).toBe("Original title");
    const rollbackRows = await db.select().from(rollbacks).where(eq(rollbacks.entityId, seriesId));
    expect(rollbackRows).toHaveLength(1);
    expect(
      await db.select().from(calendarOutbox).where(eq(calendarOutbox.id, row.id)),
    ).toHaveLength(0);
  });

  it("a permanent 4xx rejects at once: reverts and writes a Rollback", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId); // no upstreamSnapshot yet
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    const client = fakeClient({
      insertEvent: async () => {
        throw new GoogleCalendarWriteError("permanent", 400, "invalid recurrence");
      },
    });

    await processOutboxEntry(db, row.id, { client, accessToken: "tok" });

    const seriesAfter = await seriesRowFor(seriesId);
    // No upstreamSnapshot existed — the honest revert is a soft-delete (nothing to revert *to*).
    expect(seriesAfter.deletedAt).not.toBeNull();
    const rollbackRows = await db.select().from(rollbacks).where(eq(rollbacks.entityId, seriesId));
    expect(rollbackRows).toHaveLength(1);
    expect(rollbackRows[0]?.reason).toContain("invalid recurrence");
  });

  it("a transient failure retries with backoff rather than rejecting", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    const client = fakeClient({
      insertEvent: async () => {
        throw new GoogleCalendarWriteError("transient", 503, "upstream unavailable");
      },
    });

    await processOutboxEntry(db, row.id, { client, accessToken: "tok" });

    const after = await outboxRowById(row.id);
    expect(after).toBeDefined();
    expect(after?.nextAttemptAt).not.toBeNull();
    expect(after?.lastError).toContain("upstream unavailable");
    expect(await db.select().from(rollbacks).where(eq(rollbacks.entityId, seriesId))).toHaveLength(
      0,
    );
  });

  it("a live Needs-Reauth response holds the row with no deadline burned", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    const client = fakeClient({
      insertEvent: async () => {
        throw new GoogleCalendarWriteError("needsReauth", 401, "invalid_grant");
      },
    });

    await processOutboxEntry(db, row.id, { client, accessToken: "tok" });

    const after = await outboxRowById(row.id);
    expect(after?.attempts).toBe(0);
    expect(after?.nextAttemptAt).toBeNull();
    expect(after?.deadline.getTime()).toBe(row.deadline.getTime());
  });

  it("a Google conflict (412) resolves the same as an already-moved etag", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: "g-1",
      etag: "etag-a",
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    const client = fakeClient({
      patchEvent: async () => {
        throw new GoogleCalendarWriteError("conflict", 412, "etag mismatch");
      },
    });

    await processOutboxEntry(db, row.id, { client, accessToken: "tok" });

    expect(await db.select().from(rollbacks).where(eq(rollbacks.entityId, seriesId))).toHaveLength(
      1,
    );
    expect(
      await db.select().from(calendarOutbox).where(eq(calendarOutbox.id, row.id)),
    ).toHaveLength(0);
  });
});

describe("processOutboxEntry — operation: 'move' (#238)", () => {
  it("cancels the source's upstream event and inserts a fresh one on the destination", async () => {
    const userId = await createUser();
    const fromCalendarId = await createCalendar(userId, "primary");
    const toCalendarId = await createCalendar(userId, "secondary");
    const sourceSeriesId = await createSeriesRow(userId, fromCalendarId, {
      upstreamId: "g-old",
      etag: "etag-old",
      deletedAt: new Date(), // `moveSeries` soft-deletes the source at once.
    });
    const destinationSeriesId = await createSeriesRow(userId, toCalendarId);
    await enqueueOutboxWrite(db, {
      userId,
      calendarId: toCalendarId,
      seriesId: destinationSeriesId,
      operation: "move",
      sendInvitations: true,
      moveFromSeriesId: sourceSeriesId,
    });
    const row = await outboxRowFor(destinationSeriesId);

    const patchCalls: { calendarId: string; eventId: string; params: PatchEventParams }[] = [];
    const client = fakeClient({
      patchEvent: async (_token, calId, eventId, params) => {
        patchCalls.push({ calendarId: calId, eventId, params });
        return { id: eventId, status: "cancelled", etag: "etag-cancelled" };
      },
      insertEvent: async () => ({ id: "g-new", status: "confirmed", etag: "etag-new" }),
    });

    await processOutboxEntry(db, row.id, { client, accessToken: "tok" });

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toMatchObject({ calendarId: "primary", eventId: "g-old" });
    expect(patchCalls[0]?.params.body.status).toBe("cancelled");
    const destinationAfter = await seriesRowFor(destinationSeriesId);
    expect(destinationAfter.upstreamId).toBe("g-new");
    expect(destinationAfter.etag).toBe("etag-new");
    expect(
      await db.select().from(calendarOutbox).where(eq(calendarOutbox.id, row.id)),
    ).toHaveLength(0);
  });

  it("inserts with no cancel when the source never had an upstream event", async () => {
    const userId = await createUser();
    const fromCalendarId = await createCalendar(userId, "primary");
    const toCalendarId = await createCalendar(userId, "secondary");
    const sourceSeriesId = await createSeriesRow(userId, fromCalendarId, {
      deletedAt: new Date(),
    });
    const destinationSeriesId = await createSeriesRow(userId, toCalendarId);
    await enqueueOutboxWrite(db, {
      userId,
      calendarId: toCalendarId,
      seriesId: destinationSeriesId,
      operation: "move",
      sendInvitations: true,
      moveFromSeriesId: sourceSeriesId,
    });
    const row = await outboxRowFor(destinationSeriesId);

    let patchCalled = false;
    const client = fakeClient({
      patchEvent: async () => {
        patchCalled = true;
        throw new Error("nothing upstream to cancel");
      },
      insertEvent: async () => ({ id: "g-new", status: "confirmed", etag: "etag-new" }),
    });

    await processOutboxEntry(db, row.id, { client, accessToken: "tok" });

    expect(patchCalled).toBe(false);
    expect((await seriesRowFor(destinationSeriesId)).upstreamId).toBe("g-new");
  });

  it("rolls back as one unit when the destination insert fails after the source was cancelled: uncancels the source upstream, restores it locally, and drops the destination", async () => {
    const userId = await createUser();
    const fromCalendarId = await createCalendar(userId, "primary");
    const toCalendarId = await createCalendar(userId, "secondary");
    const sourceSeriesId = await createSeriesRow(userId, fromCalendarId, {
      upstreamId: "g-old",
      etag: "etag-old",
      deletedAt: new Date(),
    });
    const destinationSeriesId = await createSeriesRow(userId, toCalendarId);
    await enqueueOutboxWrite(db, {
      userId,
      calendarId: toCalendarId,
      seriesId: destinationSeriesId,
      operation: "move",
      sendInvitations: true,
      moveFromSeriesId: sourceSeriesId,
    });
    const row = await outboxRowFor(destinationSeriesId);

    const patchedStatuses: (string | undefined)[] = [];
    const client = fakeClient({
      patchEvent: async (_token, _calId, _eventId, params) => {
        patchedStatuses.push(params.body.status);
        return { id: "g-old", status: params.body.status ?? "confirmed", etag: "etag-x" };
      },
      insertEvent: async () => {
        throw new GoogleCalendarWriteError("permanent", 400, "destination rejected the insert");
      },
    });

    await processOutboxEntry(db, row.id, { client, accessToken: "tok" });

    // Cancelled, then best-effort uncancelled once the insert failed.
    expect(patchedStatuses).toEqual(["cancelled", "confirmed"]);

    const sourceAfter = await seriesRowFor(sourceSeriesId);
    expect(sourceAfter.deletedAt).toBeNull(); // Restored — the Move is undone as one unit.

    const destinationAfter = await seriesRowFor(destinationSeriesId);
    expect(destinationAfter.deletedAt).not.toBeNull(); // Never confirmed upstream — dropped.

    const rollbackRows = await db
      .select()
      .from(rollbacks)
      .where(eq(rollbacks.entityId, sourceSeriesId));
    expect(rollbackRows).toHaveLength(1);
    expect(rollbackRows[0]?.reason).toContain("destination rejected the insert");
    expect(
      await db.select().from(calendarOutbox).where(eq(calendarOutbox.id, row.id)),
    ).toHaveLength(0);
  });
});
