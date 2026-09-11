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
  series,
  users,
} from "../../db/schema.js";
import { createTestDb, resetTestDb } from "../../test-support/db.js";
import { enqueueOutboxWrite } from "../outbox-store.js";
import { type CaldavAuth, type CaldavCalendarClient, CaldavWriteError } from "./client.js";
import { processCaldavOutboxEntry } from "./outbox-processor.js";

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
const CALENDAR_HREF = "https://dav.example.com/calendars/user/work/";

async function createCalendar(userId: string): Promise<string> {
  const id = `caldav:${CONNECTED_ACCOUNT_ID}:${CALENDAR_HREF}`;
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
    davScheduleTag: string | null;
    upstreamSnapshot: Record<string, unknown> | null;
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
    upstreamId: patch.upstreamId ?? null,
    etag: patch.etag ?? null,
    davScheduleTag: patch.davScheduleTag ?? null,
    upstreamSnapshot: patch.upstreamSnapshot,
  });
  return id;
}

const auth: CaldavAuth = { username: "u", password: "p" };

function fakeClient(overrides: Partial<CaldavCalendarClient> = {}): CaldavCalendarClient {
  return {
    listCalendars: async () => [],
    getCtag: async () => null,
    syncCollection: async () => ({ kind: "staleToken" }),
    multiget: async () => [],
    putObject: async () => {
      throw new Error("putObject not stubbed");
    },
    ...overrides,
  };
}

async function enqueueAndFetchRow(params: {
  userId: string;
  calendarId: string;
  seriesId: string;
  operation: "upsert" | "cancel" | "restore";
}): Promise<CalendarOutboxRow> {
  await enqueueOutboxWrite(db, { ...params, sendInvitations: true });
  const [row] = await db
    .select()
    .from(calendarOutbox)
    .where(eq(calendarOutbox.seriesId, params.seriesId));
  if (!row) throw new Error("expected a queued outbox row");
  return row;
}

describe("processCaldavOutboxEntry", () => {
  it("PUTs a new event with If-None-Match and stores the returned etag/upstreamId/Schedule-Tag", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId);
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    let capturedOpts: { ifMatchEtag?: string | null; isCreate: boolean } | undefined;
    const client = fakeClient({
      putObject: async (_auth, _url, _body, opts) => {
        capturedOpts = opts;
        return { etag: "etag-1", scheduleTag: "sched-1" };
      },
    });

    await processCaldavOutboxEntry(db, row.id, { client, auth });

    expect(capturedOpts?.isCreate).toBe(true);
    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(seriesRow?.etag).toBe("etag-1");
    expect(seriesRow?.davScheduleTag).toBe("sched-1");
    expect(seriesRow?.upstreamId).toContain(CALENDAR_HREF);
    expect(await db.select().from(calendarOutbox)).toHaveLength(0);
  });

  it("PUTs an update with If-Match and If-Schedule-Tag-Match for an already-confirmed Series", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const upstreamUrl = `${CALENDAR_HREF}existing.ics`;
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: upstreamUrl,
      etag: "etag-old",
      davScheduleTag: "sched-old",
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    let capturedUrl: string | undefined;
    let capturedOpts:
      | { ifMatchEtag?: string | null; ifScheduleTagMatch?: string | null }
      | undefined;
    const client = fakeClient({
      putObject: async (_auth, url, _body, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return { etag: "etag-new", scheduleTag: "sched-new" };
      },
    });

    await processCaldavOutboxEntry(db, row.id, { client, auth });

    expect(capturedUrl).toBe(upstreamUrl);
    expect(capturedOpts?.ifMatchEtag).toBe("etag-old");
    expect(capturedOpts?.ifScheduleTagMatch).toBe("sched-old");
  });

  it("on a 412 conflict, reverts from the upstream snapshot and writes a Rollback", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: `${CALENDAR_HREF}existing.ics`,
      etag: "etag-old",
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
        reminders: [],
        upstreamId: `${CALENDAR_HREF}existing.ics`,
        etag: "etag-old",
      },
    });
    await db.update(series).set({ title: "Edited locally" }).where(eq(series.id, seriesId));
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    const client = fakeClient({
      putObject: async () => {
        throw new CaldavWriteError("conflict", 412, "precondition failed");
      },
    });

    await processCaldavOutboxEntry(db, row.id, { client, auth });

    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(seriesRow?.title).toBe("Original title");
    const rollbackRows = await db.select().from(rollbacks).where(eq(rollbacks.userId, userId));
    expect(rollbackRows).toHaveLength(1);
    expect(await db.select().from(calendarOutbox)).toHaveLength(0);
  });

  it("on a 401, releases the row for Reauth without counting the attempt or writing a Rollback", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: `${CALENDAR_HREF}existing.ics`,
      etag: "etag-old",
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "upsert" });

    const client = fakeClient({
      putObject: async () => {
        throw new CaldavWriteError("needsReauth", 401, "unauthorized");
      },
    });

    await processCaldavOutboxEntry(db, row.id, { client, auth });

    const [outboxRow] = await db
      .select()
      .from(calendarOutbox)
      .where(eq(calendarOutbox.seriesId, seriesId));
    expect(outboxRow).toBeDefined();
    expect(outboxRow?.attempts).toBe(0);
    expect(await db.select().from(rollbacks)).toHaveLength(0);
  });

  it("cancel re-PUTs the fetched body as STATUS:CANCELLED against the existing upstreamId", async () => {
    const userId = await createUser();
    const calendarId = await createCalendar(userId);
    const upstreamUrl = `${CALENDAR_HREF}existing.ics`;
    const seriesId = await createSeriesRow(userId, calendarId, {
      upstreamId: upstreamUrl,
      etag: "etag-old",
    });
    const row = await enqueueAndFetchRow({ userId, calendarId, seriesId, operation: "cancel" });

    let capturedBody: string | undefined;
    const client = fakeClient({
      putObject: async (_auth, _url, body) => {
        capturedBody = body;
        return { etag: "etag-cancelled", scheduleTag: null };
      },
    });

    await processCaldavOutboxEntry(db, row.id, { client, auth });

    expect(capturedBody).toContain("STATUS:CANCELLED");
  });
});
