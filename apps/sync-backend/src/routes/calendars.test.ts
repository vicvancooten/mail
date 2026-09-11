import { randomUUID } from "node:crypto";
import type {
  CalendarDelta,
  EventDelta,
  EventRangeResponse,
  SeriesBodyResponse,
} from "@mail/shared";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import { computeMaterialisationWindow } from "../calendars/materialise-loop.js";
import { rematerialiseSeries } from "../calendars/series-store.js";
import type { Db } from "../db/client.js";
import { calendars, events, overrides, series, users } from "../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

const PUBLIC_URL = "http://localhost:3000";

let db: Db;
let closeDb: () => Promise<void>;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
}

function buildTestApp() {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    mailAccountVerify: async () => ({ ok: true, serverKind: "generic" }),
  });
}

async function claimOwner(app: FastifyInstance): Promise<{ cookie: string; userId: string }> {
  let captured = "";
  const originalInfo = app.log.info.bind(app.log);
  app.log.info = ((payload: unknown, ...rest: unknown[]) => {
    if (typeof payload === "object" && payload && "claimToken" in payload) {
      captured = String((payload as { claimToken: string }).claimToken);
    }
    return originalInfo(payload as never, ...(rest as []));
  }) as typeof app.log.info;
  await ensureClaimToken(db, app.log, PUBLIC_URL);
  app.log.info = originalInfo;

  const response = await app.inject({
    method: "POST",
    url: "/auth/claim",
    payload: { token: captured, username: "vic", password: "a-long-enough-password" },
  });
  const cookie = extractCookie(response.headers["set-cookie"]);
  const userId = (response.json() as { user: { id: string } }).user.id;
  return { cookie, userId };
}

/** Seeds the one Local Personal Calendar the way every Client actually gets one — through `/sync`, not a direct insert. */
async function seedPersonalCalendar(app: FastifyInstance, cookie: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/sync",
    headers: { cookie },
    payload: { user: { Calendar: null } },
  });
  const delta = response.json().user.Calendar as CalendarDelta;
  const calendarId = delta.created[0]?.id;
  if (!calendarId) throw new Error("Personal Calendar was not seeded");
  return calendarId;
}

async function insertMirroredCalendar(userId: string): Promise<string> {
  const id = `gcal:acct-1:${randomUUID()}`;
  await db.insert(calendars).values({
    id,
    userId,
    name: "Work",
    description: null,
    timeZone: "UTC",
    originType: "connectedAccount",
    connectedAccountId: "acct-1",
    color: "#4285F4",
    isDefault: false,
    mailAccountId: null,
    mirrored: true,
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
  });
  return id;
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

describe("Series, Overrides and the materialiser (#230)", () => {
  it("a weekly Series with one Override and one exdate materialises the right Occurrence rows, visible through /sync", async () => {
    const app = buildTestApp();
    const { cookie } = await claimOwner(app);
    const calendarId = await seedPersonalCalendar(app, cookie);
    const [owner] = await db.select({ id: users.id }).from(users).limit(1);
    if (!owner) throw new Error("no owner row after claim");

    const seriesId = randomUUID();
    const dtstart = new Date(Date.UTC(2026, 0, 5, 9, 0, 0)); // Monday 9am UTC
    await db.insert(series).values({
      id: seriesId,
      userId: owner.id,
      calendarId,
      uid: `${seriesId}@wicket`,
      title: "Standup",
      description: "Daily sync",
      location: null,
      allDay: false,
      floating: false,
      tzid: null,
      dtstart,
      durationMs: 60 * 60 * 1000,
      rrules: ["FREQ=WEEKLY;BYDAY=MO"],
      rdates: [],
      exdates: ["2026-01-12T09:00:00.000Z"], // cancelled: an exdate and nothing more
      attendees: [{ email: "vic@example.com", name: null, responseStatus: "accepted" }],
    });
    await db.insert(overrides).values({
      id: randomUUID(),
      seriesId,
      originalStart: new Date(Date.UTC(2026, 0, 19, 9, 0, 0)),
      start: new Date(Date.UTC(2026, 0, 19, 14, 0, 0)),
      end: new Date(Date.UTC(2026, 0, 19, 15, 0, 0)),
      title: "Standup (moved)",
      location: "Room 2",
    });

    // The daily sweep is what actually calls this in production
    // (`calendars/materialise-loop.ts`) — called directly here so the test
    // does not wait a day for it.
    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    if (!seriesRow) throw new Error("Series row missing after insert");
    const window = computeMaterialisationWindow(new Date(Date.UTC(2026, 0, 1)));
    await rematerialiseSeries(db, seriesRow, window.start, window.end);

    const eventDelta = await app.inject({
      method: "POST",
      url: "/sync",
      headers: { cookie },
      payload: { user: { Event: null } },
    });
    const delta = eventDelta.json().user.Event as EventDelta;

    // Mondays in Jan 2026: 5, 12 (exdate'd, absent), 19 (overridden), 26, and
    // every other Monday out to the Materialisation Window's edge.
    const jan = delta.created.filter((event) => event.originalStart.startsWith("2026-01-"));
    expect(jan.map((event) => event.originalStart)).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-01-19T09:00:00.000Z",
      "2026-01-26T09:00:00.000Z",
    ]);

    const plain = jan.find((event) => event.originalStart === "2026-01-05T09:00:00.000Z");
    expect(plain).toMatchObject({
      title: "Standup",
      location: null,
      start: "2026-01-05T09:00:00.000Z",
      end: "2026-01-05T10:00:00.000Z",
      status: "confirmed",
      allDay: false,
      floating: false,
      tzid: null,
      transparency: "opaque",
    });
    expect(plain?.id).toBe(`${seriesId}@2026-01-05T09:00:00.000Z`);

    const moved = jan.find((event) => event.originalStart === "2026-01-19T09:00:00.000Z");
    expect(moved).toMatchObject({
      title: "Standup (moved)",
      location: "Room 2",
      start: "2026-01-19T14:00:00.000Z",
      end: "2026-01-19T15:00:00.000Z",
    });

    // The Series body is a separate, on-demand fetch — never part of the
    // Event delta itself (this ticket's acceptance line).
    const seriesBody = await app.inject({
      method: "GET",
      url: `/calendars/${calendarId}/series/${seriesId}`,
      headers: { cookie },
    });
    expect(seriesBody.statusCode).toBe(200);
    const body = seriesBody.json() as SeriesBodyResponse;
    expect(body.series).toMatchObject({
      id: seriesId,
      title: "Standup",
      description: "Daily sync",
      rrules: ["FREQ=WEEKLY;BYDAY=MO"],
      exdates: ["2026-01-12T09:00:00.000Z"],
      attendees: [{ email: "vic@example.com", name: null, responseStatus: "accepted" }],
    });
    expect(body.overrides).toHaveLength(1);
    expect(body.overrides[0]).toMatchObject({ title: "Standup (moved)", location: "Room 2" });
  });

  it("re-materialising after the window rolls forward destroys Occurrences that fell out of it", async () => {
    const app = buildTestApp();
    const { cookie } = await claimOwner(app);
    const calendarId = await seedPersonalCalendar(app, cookie);
    const [owner] = await db.select({ id: users.id }).from(users).limit(1);
    if (!owner) throw new Error("no owner row after claim");

    const seriesId = randomUUID();
    await db.insert(series).values({
      id: seriesId,
      userId: owner.id,
      calendarId,
      uid: `${seriesId}@wicket`,
      title: "One-off",
      description: null,
      location: null,
      allDay: false,
      floating: false,
      tzid: null,
      dtstart: new Date(Date.UTC(2026, 0, 5, 9, 0, 0)),
      durationMs: 30 * 60 * 1000,
      rrules: [],
      rdates: [],
      exdates: [],
      attendees: [],
    });

    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    if (!seriesRow) throw new Error("Series row missing after insert");

    await rematerialiseSeries(
      db,
      seriesRow,
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 1, 1)),
    );
    const firstSync = await app.inject({
      method: "POST",
      url: "/sync",
      headers: { cookie },
      payload: { user: { Event: null } },
    });
    const firstDelta = firstSync.json().user.Event as EventDelta;
    expect(firstDelta.created).toHaveLength(1);
    const eventId = firstDelta.created[0]?.id;

    // The window rolls past the one Occurrence entirely.
    await rematerialiseSeries(
      db,
      seriesRow,
      new Date(Date.UTC(2027, 0, 1)),
      new Date(Date.UTC(2027, 1, 1)),
    );
    const secondSync = await app.inject({
      method: "POST",
      url: "/sync",
      headers: { cookie },
      payload: { user: { Event: firstDelta.newState } },
    });
    const secondDelta = secondSync.json().user.Event as EventDelta;
    expect(secondDelta.destroyed).toEqual([eventId]);
    expect(secondDelta.created).toHaveLength(0);
  });

  it("the on-demand Series body fetch 404s for a Series on a Calendar the caller does not own", async () => {
    const app = buildTestApp();
    const { cookie } = await claimOwner(app);
    const calendarId = await seedPersonalCalendar(app, cookie);

    const response = await app.inject({
      method: "GET",
      url: `/calendars/${calendarId}/series/does-not-exist`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /calendars/events (#232)", () => {
  it("requires auth", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/calendars/events?start=2026-01-01T00:00:00.000Z&end=2026-02-01T00:00:00.000Z",
    });
    expect(response.statusCode).toBe(401);
  });

  it("400s on a missing or backwards range", async () => {
    const app = buildTestApp();
    const { cookie } = await claimOwner(app);

    const missing = await app.inject({
      method: "GET",
      url: "/calendars/events",
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(400);

    const backwards = await app.inject({
      method: "GET",
      url: "/calendars/events?start=2026-02-01T00:00:00.000Z&end=2026-01-01T00:00:00.000Z",
      headers: { cookie },
    });
    expect(backwards.statusCode).toBe(400);
  });

  it("a range inside the Materialisation Window reads the already-materialised rows, not the delta", async () => {
    const app = buildTestApp();
    const { cookie } = await claimOwner(app);
    const calendarId = await seedPersonalCalendar(app, cookie);
    const [owner] = await db.select({ id: users.id }).from(users).limit(1);
    if (!owner) throw new Error("no owner row after claim");

    const seriesId = randomUUID();
    const dtstart = new Date(Date.UTC(2020, 0, 6, 9, 0, 0)); // a Monday, well before any window
    await db.insert(series).values({
      id: seriesId,
      userId: owner.id,
      calendarId,
      uid: `${seriesId}@wicket`,
      title: "Standup",
      description: null,
      location: null,
      allDay: false,
      floating: false,
      tzid: null,
      dtstart,
      durationMs: 30 * 60 * 1000,
      rrules: ["FREQ=WEEKLY;BYDAY=MO"],
      rdates: [],
      exdates: [],
      attendees: [],
    });
    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    if (!seriesRow) throw new Error("Series row missing after insert");

    const matWindow = computeMaterialisationWindow();
    await rematerialiseSeries(db, seriesRow, matWindow.start, matWindow.end);

    // Pick a Monday well inside the Materialisation Window but past the Event
    // Window's own future edge, so this genuinely exercises the range fetch
    // rather than something an ordinary `Event` sync round would have handed
    // back already.
    const target = new Date(matWindow.end.getTime() - 20 * 24 * 60 * 60 * 1000);
    const dayOfWeek = (target.getUTCDay() + 6) % 7; // Monday=0
    const monday = new Date(target.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
    monday.setUTCHours(9, 0, 0, 0);
    const rangeStart = new Date(monday.getTime() - 24 * 60 * 60 * 1000);
    const rangeEnd = new Date(monday.getTime() + 24 * 60 * 60 * 1000);

    const beforeCount = (await db.select().from(events)).length;
    const response = await app.inject({
      method: "GET",
      url: `/calendars/events?start=${rangeStart.toISOString()}&end=${rangeEnd.toISOString()}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as EventRangeResponse;
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ title: "Standup", start: monday.toISOString() });
    expect(new Date(body.windowStart).getTime()).toBeLessThan(Date.now());
    expect(new Date(body.windowEnd).getTime()).toBeGreaterThan(Date.now());

    // Reading a range never writes: no row was materialised as a side effect.
    const afterCount = (await db.select().from(events)).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("a range beyond the Materialisation Window computes Occurrences on request and stores none", async () => {
    const app = buildTestApp();
    const { cookie } = await claimOwner(app);
    const calendarId = await seedPersonalCalendar(app, cookie);
    const [owner] = await db.select({ id: users.id }).from(users).limit(1);
    if (!owner) throw new Error("no owner row after claim");

    const seriesId = randomUUID();
    await db.insert(series).values({
      id: seriesId,
      userId: owner.id,
      calendarId,
      uid: `${seriesId}@wicket`,
      title: "Standup",
      description: null,
      location: null,
      allDay: false,
      floating: false,
      tzid: null,
      dtstart: new Date(Date.UTC(2020, 0, 6, 9, 0, 0)),
      durationMs: 30 * 60 * 1000,
      rrules: ["FREQ=WEEKLY;BYDAY=MO"],
      rdates: [],
      exdates: [],
      attendees: [],
    });

    // Nothing has ever run the materialise sweep for this range, and it
    // never will: it's outside the Materialisation Window entirely.
    const matWindow = computeMaterialisationWindow();
    const far = new Date(matWindow.end.getTime() + 60 * 24 * 60 * 60 * 1000);
    const dayOfWeek = (far.getUTCDay() + 6) % 7;
    const monday = new Date(far.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
    monday.setUTCHours(9, 0, 0, 0);
    const rangeStart = new Date(monday.getTime() - 24 * 60 * 60 * 1000);
    const rangeEnd = new Date(monday.getTime() + 24 * 60 * 60 * 1000);

    const beforeCount = (await db.select().from(events)).length;
    const response = await app.inject({
      method: "GET",
      url: `/calendars/events?start=${rangeStart.toISOString()}&end=${rangeEnd.toISOString()}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as EventRangeResponse;
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ title: "Standup", start: monday.toISOString() });

    const afterCount = (await db.select().from(events)).length;
    expect(afterCount).toBe(beforeCount);
  });
});

describe("/calendars/:id/unmirror, /mirror, /unmirror-impact (#235)", () => {
  it("requires auth", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/calendars/does-not-exist/unmirror",
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s for a Calendar id that isn't this User's", async () => {
    const app = buildTestApp();
    const { cookie } = await claimOwner(app);

    const response = await app.inject({
      method: "POST",
      url: "/calendars/no-such-calendar/unmirror",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s attempting to unmirror the Local Personal Calendar", async () => {
    const app = buildTestApp();
    const { cookie } = await claimOwner(app);
    // Ensures the Personal Calendar exists, the same way an ordinary `Calendar` sync round does.
    await app.inject({
      method: "POST",
      url: "/sync",
      headers: { cookie },
      payload: { user: { Calendar: null } },
    });

    const [local] = await db.select().from(calendars);
    const response = await app.inject({
      method: "POST",
      url: `/calendars/${local?.id}/unmirror`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "not_mirrorable" });
  });

  it("previews, then unmirrors, and flips mirrored back on with /mirror", async () => {
    const app = buildTestApp();
    const { cookie, userId } = await claimOwner(app);
    const calendarId = await insertMirroredCalendar(userId);

    const preview = await app.inject({
      method: "GET",
      url: `/calendars/${calendarId}/unmirror-impact`,
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ discarded: { events: 0 } });

    const unmirrored = await app.inject({
      method: "POST",
      url: `/calendars/${calendarId}/unmirror`,
      headers: { cookie },
    });
    expect(unmirrored.statusCode).toBe(200);
    const unmirroredBody = unmirrored.json() as { calendar: { mirrored: boolean } };
    expect(unmirroredBody.calendar.mirrored).toBe(false);

    const remirrored = await app.inject({
      method: "POST",
      url: `/calendars/${calendarId}/mirror`,
      headers: { cookie },
    });
    expect(remirrored.statusCode).toBe(200);
    const remirroredBody = remirrored.json() as { calendar: { mirrored: boolean } };
    expect(remirroredBody.calendar.mirrored).toBe(true);
  });
});
