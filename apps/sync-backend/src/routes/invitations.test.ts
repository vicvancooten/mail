import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSession } from "../auth/sessions.js";
import { ensurePersonalCalendar } from "../calendars/store.js";
import type { Db } from "../db/client.js";
import {
  calendarOutbox,
  calendars,
  folders,
  type InvitationParticipant,
  imipReplies,
  invitations,
  messages,
  series,
  threads,
} from "../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";

const PUBLIC_URL = "http://localhost:3000";

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

function buildTestApp() {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    mailAccountVerify: async () => ({ ok: true, serverKind: "generic" }),
  });
}

async function cookieFor(userId: string): Promise<string> {
  const { token } = await createSession(db, userId);
  return `mail_session=${token}`;
}

const ORGANIZER: InvitationParticipant = {
  name: "Organiser",
  address: "organiser@example.com",
  role: null,
  partstat: null,
};

async function seedThreadAndInvitation(
  mailAccountId: string,
  uid: string,
  attendees: InvitationParticipant[] = [],
): Promise<{ threadId: string }> {
  const threadId = randomUUID();
  await db.insert(threads).values({ id: threadId, mailAccountId });
  await db
    .insert(folders)
    .values({ id: randomUUID(), mailAccountId, path: "INBOX", name: "INBOX", role: "inbox" })
    .onConflictDoNothing({ target: [folders.mailAccountId, folders.path] });
  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.mailAccountId, mailAccountId), eq(folders.path, "INBOX")));
  if (!folder) throw new Error("INBOX was not seeded");

  const messageId = randomUUID();
  await db.insert(messages).values({
    id: messageId,
    mailAccountId,
    threadId,
    folderId: folder.id,
    uid: 1,
    subject: "Standup",
    fromName: "Organiser",
    fromAddress: "organiser@example.com",
    sentAt: new Date("2026-01-01T00:00:00Z"),
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    seen: false,
    flagged: false,
    attachments: [],
    bodyText: "hi",
    bodyHtml: "<p>hi</p>",
  });

  await db.insert(invitations).values({
    id: randomUUID(),
    mailAccountId,
    messageId,
    threadId,
    kind: "request",
    method: "REQUEST",
    source: "ical",
    uid,
    recurrenceId: "",
    sequence: 0,
    dtstamp: new Date("2026-01-01T00:00:00Z"),
    organizer: ORGANIZER,
    attendees,
    vevent: {
      title: "Standup",
      description: null,
      location: null,
      start: "2026-01-05T09:00:00.000Z",
      end: "2026-01-05T09:30:00.000Z",
      allDay: false,
      tzid: "UTC",
      status: "CONFIRMED",
    },
  });

  return { threadId };
}

describe("GET /threads/:threadId/invitations", () => {
  it("404s for a Thread this User's Mail Accounts never touched", async () => {
    const app = buildTestApp();
    const account = await createTestMailAccount(db);
    const cookie = await cookieFor(account.userId);

    const response = await app.inject({
      method: "GET",
      url: `/threads/${randomUUID()}/invitations`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns the invite card for a Thread the User's own Mail Account received", async () => {
    const app = buildTestApp();
    const account = await createTestMailAccount(db);
    const cookie = await cookieFor(account.userId);
    const { threadId } = await seedThreadAndInvitation(account.id, "uid-1");

    const response = await app.inject({
      method: "GET",
      url: `/threads/${threadId}/invitations`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { cards: Array<{ uid: string; match: unknown }> };
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]?.uid).toBe("uid-1");
    expect(body.cards[0]?.match).toBeNull();
  });
});

describe("POST /calendars/series/:seriesId/answer", () => {
  async function seedMirroredSeries(
    userId: string,
    connectedAccountId: string,
    selfEmail: string,
  ): Promise<string> {
    const calendarId = `gcal:${connectedAccountId}:${randomUUID()}`;
    await db.insert(calendars).values({
      id: calendarId,
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
      capabilities: { ...LOCAL_CALENDAR_CAPABILITIES, writable: true },
    });
    const seriesId = randomUUID();
    await db.insert(series).values({
      id: seriesId,
      userId,
      calendarId,
      uid: "uid-1",
      title: "Standup",
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      durationMs: 30 * 60 * 1000,
      transparency: "opaque",
      attendees: [{ email: selfEmail, name: null, responseStatus: "needsAction" }],
    });
    return seriesId;
  }

  it("answers, returns the previous responseStatus, and enqueues a 'respond' outbox row", async () => {
    const app = buildTestApp();
    const account = await createTestMailAccount(db);
    const cookie = await cookieFor(account.userId);
    const seriesId = await seedMirroredSeries(
      account.userId,
      account.connectedAccountId,
      account.emailAddress,
    );

    const response = await app.inject({
      method: "POST",
      url: `/calendars/series/${seriesId}/answer`,
      headers: { cookie },
      payload: { responseStatus: "accepted" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, previousResponseStatus: "needsAction" });

    const outboxRows = await db
      .select()
      .from(calendarOutbox)
      .where(eq(calendarOutbox.seriesId, seriesId));
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({ operation: "respond", responseStatus: "accepted" });
  });

  it("400s not_synced for a Local Calendar's Series", async () => {
    const app = buildTestApp();
    const account = await createTestMailAccount(db);
    const cookie = await cookieFor(account.userId);
    const calendarId = `local:${randomUUID()}`;
    await db.insert(calendars).values({
      id: calendarId,
      userId: account.userId,
      name: "Personal",
      description: null,
      timeZone: "UTC",
      originType: "local",
      connectedAccountId: null,
      color: "#4285F4",
      isDefault: true,
      mailAccountId: account.id,
      mirrored: true,
      capabilities: LOCAL_CALENDAR_CAPABILITIES,
    });
    const seriesId = randomUUID();
    await db.insert(series).values({
      id: seriesId,
      userId: account.userId,
      calendarId,
      uid: "uid-local",
      title: "Standup",
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      durationMs: 30 * 60 * 1000,
      transparency: "opaque",
    });

    const response = await app.inject({
      method: "POST",
      url: `/calendars/series/${seriesId}/answer`,
      headers: { cookie },
      payload: { responseStatus: "accepted" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "not_synced" });
  });

  it("404s series_not_found for a Series id nobody owns", async () => {
    const app = buildTestApp();
    const account = await createTestMailAccount(db);
    const cookie = await cookieFor(account.userId);

    const response = await app.inject({
      method: "POST",
      url: `/calendars/series/${randomUUID()}/answer`,
      headers: { cookie },
      payload: { responseStatus: "accepted" },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("the Local fallback (#241, ADR-0027)", () => {
  it("GET /threads/:threadId/invitations creates a fallback Series and marks the card an Attendee's", async () => {
    const app = buildTestApp();
    const account = await createTestMailAccount(db);
    await ensurePersonalCalendar(db, account.userId);
    const cookie = await cookieFor(account.userId);
    const { threadId } = await seedThreadAndInvitation(account.id, "uid-local", [
      { name: null, address: account.emailAddress, role: null, partstat: null },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/threads/${threadId}/invitations`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      cards: Array<{
        match: { synced: boolean; isAttendee: boolean } | null;
        offerAddToCalendar: boolean;
      }>;
    };
    expect(body.cards[0]?.match).toMatchObject({ synced: false, isAttendee: true });
    expect(body.cards[0]?.offerAddToCalendar).toBe(false);

    const rows = await db.select().from(series).where(eq(series.uid, "uid-local"));
    expect(rows).toHaveLength(1);
  });

  it("offers offerAddToCalendar for an Invitation naming nobody the User is", async () => {
    const app = buildTestApp();
    const account = await createTestMailAccount(db);
    await ensurePersonalCalendar(db, account.userId);
    const cookie = await cookieFor(account.userId);
    const { threadId } = await seedThreadAndInvitation(account.id, "uid-nobody", [
      { name: null, address: "someone-else@example.com", role: null, partstat: null },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/threads/${threadId}/invitations`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      cards: Array<{ match: unknown; offerAddToCalendar: boolean }>;
    };
    expect(body.cards[0]?.match).toBeNull();
    expect(body.cards[0]?.offerAddToCalendar).toBe(true);
  });

  it("POST answer-local queues a Reply and updates the Series' Attendee entry", async () => {
    const app = buildTestApp();
    const account = await createTestMailAccount(db);
    // ADR-0027: "the Personal Calendar takes the User's first Mail Account" —
    // `ensurePersonalCalendar` seeds it from the User's oldest Mail Account,
    // which already exists at this point.
    await ensurePersonalCalendar(db, account.userId);
    const cookie = await cookieFor(account.userId);
    const { threadId } = await seedThreadAndInvitation(account.id, "uid-local-2", [
      { name: null, address: account.emailAddress, role: null, partstat: null },
    ]);
    await app.inject({
      method: "GET",
      url: `/threads/${threadId}/invitations`,
      headers: { cookie },
    });
    const [seriesRow] = await db.select().from(series).where(eq(series.uid, "uid-local-2"));
    if (!seriesRow) throw new Error("expected the fallback Series to exist");

    const response = await app.inject({
      method: "POST",
      url: `/calendars/series/${seriesRow.id}/answer-local`,
      headers: { cookie },
      payload: { responseStatus: "accepted" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: true; previousResponseStatus: string; replyId: string };
    expect(body.previousResponseStatus).toBe("needsAction");

    const [reply] = await db.select().from(imipReplies).where(eq(imipReplies.id, body.replyId));
    expect(reply?.status).toBe("pending");

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/calendars/replies/${body.replyId}/cancel-send`,
      headers: { cookie },
      payload: { previousResponseStatus: "needsAction" },
    });
    expect(cancelResponse.statusCode).toBe(200);
    const [cancelled] = await db.select().from(imipReplies).where(eq(imipReplies.id, body.replyId));
    expect(cancelled?.status).toBe("cancelled");
  });

  it("POST add-to-calendar creates a private copy with no Attendee entry of the User's own", async () => {
    const app = buildTestApp();
    const account = await createTestMailAccount(db);
    await ensurePersonalCalendar(db, account.userId);
    const cookie = await cookieFor(account.userId);
    const { threadId } = await seedThreadAndInvitation(account.id, "uid-forwarded", [
      { name: null, address: "someone-else@example.com", role: null, partstat: null },
    ]);

    const response = await app.inject({
      method: "POST",
      url: `/threads/${threadId}/invitations/uid-forwarded/add-to-calendar`,
      headers: { cookie },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const [row] = await db.select().from(series).where(eq(series.uid, "uid-forwarded"));
    expect(row?.attendees).toEqual([]);
  });
});
