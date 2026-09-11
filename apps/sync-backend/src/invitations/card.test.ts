import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  calendars,
  events,
  folders,
  type InvitationParticipant,
  invitations,
  messages,
  series,
  threads,
} from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildInvitationCards } from "./card.js";

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

const ORGANIZER: InvitationParticipant = {
  name: "Organiser",
  address: "organiser@example.com",
  role: null,
  partstat: null,
};

let nextUid = 1;

async function seedThreadAndMessage(
  mailAccountId: string,
  fromAddress = "organiser@example.com",
  existingThreadId?: string,
): Promise<{ threadId: string; messageId: string }> {
  const threadId = existingThreadId ?? randomUUID();
  if (!existingThreadId) {
    await db.insert(threads).values({ id: threadId, mailAccountId });
  }

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
    uid: nextUid++,
    subject: "Standup",
    fromName: "Organiser",
    fromAddress,
    sentAt: new Date("2026-01-01T00:00:00Z"),
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    seen: false,
    flagged: false,
    attachments: [],
    bodyText: "hi",
    bodyHtml: "<p>hi</p>",
  });
  return { threadId, messageId };
}

async function seedInvitation(params: {
  mailAccountId: string;
  messageId: string;
  threadId: string;
  uid: string;
  sequence?: number;
  kind?: "request" | "answer" | "cancellation";
  attendees?: InvitationParticipant[];
}): Promise<void> {
  await db.insert(invitations).values({
    id: randomUUID(),
    mailAccountId: params.mailAccountId,
    messageId: params.messageId,
    threadId: params.threadId,
    kind: params.kind ?? "request",
    method: "REQUEST",
    source: "ical",
    uid: params.uid,
    recurrenceId: "",
    sequence: params.sequence ?? 0,
    dtstamp: new Date("2026-01-01T00:00:00Z"),
    organizer: ORGANIZER,
    attendees: params.attendees ?? [],
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
}

async function createMirroredCalendar(userId: string, connectedAccountId: string): Promise<string> {
  const id = `gcal:${connectedAccountId}:${randomUUID()}`;
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
    capabilities: { ...LOCAL_CALENDAR_CAPABILITIES, writable: true },
  });
  return id;
}

describe("buildInvitationCards (#240)", () => {
  it("returns one card per distinct UID, at its highest SEQUENCE revision", async () => {
    const account = await createTestMailAccount(db);
    const { threadId, messageId: firstMessageId } = await seedThreadAndMessage(account.id);
    const { messageId: secondMessageId } = await seedThreadAndMessage(
      account.id,
      "organiser@example.com",
      threadId,
    );
    await seedInvitation({
      mailAccountId: account.id,
      messageId: firstMessageId,
      threadId,
      uid: "abc",
      sequence: 0,
    });
    await seedInvitation({
      mailAccountId: account.id,
      messageId: secondMessageId,
      threadId,
      uid: "abc",
      sequence: 1,
    });

    const cards = await buildInvitationCards(db, account.userId, threadId);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.sequence).toBe(1);
  });

  it("returns match: null when no Series shares the Invitation's UID", async () => {
    const account = await createTestMailAccount(db);
    const { threadId, messageId } = await seedThreadAndMessage(account.id);
    await seedInvitation({ mailAccountId: account.id, messageId, threadId, uid: "no-match" });

    const cards = await buildInvitationCards(db, account.userId, threadId);

    expect(cards[0]?.match).toBeNull();
  });

  it("matches a Series on a synced Calendar, reporting the self attendee's live responseStatus", async () => {
    const account = await createTestMailAccount(db);
    const { threadId, messageId } = await seedThreadAndMessage(account.id);
    await seedInvitation({ mailAccountId: account.id, messageId, threadId, uid: "matched-uid" });

    const calendarId = await createMirroredCalendar(account.userId, account.connectedAccountId);
    const seriesId = randomUUID();
    await db.insert(series).values({
      id: seriesId,
      userId: account.userId,
      calendarId,
      uid: "matched-uid",
      title: "Standup",
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      durationMs: 30 * 60 * 1000,
      transparency: "opaque",
      attendees: [
        { email: account.emailAddress, name: "Me", responseStatus: "tentative" },
        { email: "someone-else@example.com", name: null, responseStatus: "accepted" },
      ],
    });

    const cards = await buildInvitationCards(db, account.userId, threadId);

    expect(cards[0]?.match).toEqual({
      calendarId,
      seriesId,
      synced: true,
      cancelled: false,
      selfEmail: account.emailAddress,
      myResponseStatus: "tentative",
      isAttendee: true,
    });
  });

  it("reports cancelled when the matched Series is soft-deleted, or an Occurrence is cancelled", async () => {
    const account = await createTestMailAccount(db);
    const { threadId, messageId } = await seedThreadAndMessage(account.id);
    await seedInvitation({ mailAccountId: account.id, messageId, threadId, uid: "cancelled-uid" });

    const calendarId = await createMirroredCalendar(account.userId, account.connectedAccountId);
    const seriesId = randomUUID();
    await db.insert(series).values({
      id: seriesId,
      userId: account.userId,
      calendarId,
      uid: "cancelled-uid",
      title: "Standup",
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      durationMs: 30 * 60 * 1000,
      transparency: "opaque",
    });
    await db.insert(events).values({
      id: randomUUID(),
      userId: account.userId,
      calendarId,
      seriesId,
      originalStart: new Date("2026-01-05T09:00:00.000Z"),
      startAt: new Date("2026-01-05T09:00:00.000Z"),
      endAt: new Date("2026-01-05T09:30:00.000Z"),
      title: "Standup",
      status: "cancelled",
    });

    const cards = await buildInvitationCards(db, account.userId, threadId);

    expect(cards[0]?.match?.cancelled).toBe(true);
  });

  it("carries the arriving Message's own fromAddress for the caution line", async () => {
    const account = await createTestMailAccount(db);
    const { threadId, messageId } = await seedThreadAndMessage(
      account.id,
      "someone-else@example.com",
    );
    await seedInvitation({ mailAccountId: account.id, messageId, threadId, uid: "abc" });

    const cards = await buildInvitationCards(db, account.userId, threadId);

    expect(cards[0]?.fromAddress).toBe("someone-else@example.com");
    expect(cards[0]?.organizer?.address).toBe("organiser@example.com");
  });
});
