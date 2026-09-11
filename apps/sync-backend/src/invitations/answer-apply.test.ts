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
  messages,
  series,
  threads,
  users,
} from "../db/schema.js";
import { listUndelivered } from "../notifier/outbox.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { applyAnswerInvitation } from "./answer-apply.js";

/**
 * `invitations/answer-apply.ts` (#243) against a real Postgres — matching by
 * `UID`+`RECURRENCE-ID`, updating the Series' own Attendee, marking the
 * Thread Done, and the coalesced "Answer received" notification are each
 * database-shaped, not pure functions.
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

const RESPONDER: InvitationParticipant = {
  address: "bob@example.com",
  name: "Bob",
  role: "REQ-PARTICIPANT",
  partstat: "ACCEPTED",
};

async function seedThreadAndInboxMessage(mailAccountId: string): Promise<string> {
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

  await db.insert(messages).values({
    id: randomUUID(),
    mailAccountId,
    threadId,
    folderId: folder.id,
    uid: 1,
    subject: "Re: Standup",
    fromName: "Bob",
    fromAddress: "bob@example.com",
    sentAt: new Date("2026-01-02T00:00:00Z"),
    receivedAt: new Date("2026-01-02T00:00:00Z"),
  });
  return threadId;
}

interface SeedSeriesOptions {
  organized?: boolean;
  attendees?: {
    email: string;
    name: string | null;
    responseStatus: "needsAction" | "accepted" | "declined" | "tentative";
  }[];
}

async function seedOrganizedSeries(
  userId: string,
  uid: string,
  { organized = true, attendees }: SeedSeriesOptions = {},
): Promise<string> {
  const calendarId = `local:${randomUUID()}`;
  await db.insert(calendars).values({
    id: calendarId,
    userId,
    name: "Personal",
    description: null,
    timeZone: "UTC",
    originType: "local",
    connectedAccountId: null,
    color: "#4285F4",
    isDefault: true,
    mailAccountId: null,
    mirrored: true,
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
  });
  const seriesId = randomUUID();
  await db.insert(series).values({
    id: seriesId,
    userId,
    calendarId,
    uid,
    title: "Standup",
    allDay: false,
    floating: false,
    tzid: "UTC",
    dtstart: new Date("2026-01-05T09:00:00.000Z"),
    durationMs: 30 * 60 * 1000,
    transparency: "opaque",
    attendees: attendees ?? [
      { email: "bob@example.com", name: "Bob", responseStatus: "needsAction" },
    ],
    organizerFirstSentAt: organized ? new Date("2026-01-01T00:00:00Z") : null,
  });
  await db.insert(events).values({
    id: randomUUID(),
    userId,
    calendarId,
    seriesId,
    originalStart: new Date("2026-01-05T09:00:00.000Z"),
    startAt: new Date("2026-01-05T09:00:00.000Z"),
    endAt: new Date("2026-01-05T09:30:00.000Z"),
    title: "Standup",
    status: "confirmed",
  });
  return seriesId;
}

describe("applyAnswerInvitation (#243)", () => {
  it("updates the Attendee's Answer, marks the Thread Done, and records a coalesced notification", async () => {
    const account = await createTestMailAccount(db);
    const threadId = await seedThreadAndInboxMessage(account.id);
    const seriesId = await seedOrganizedSeries(account.userId, "uid-1");

    await applyAnswerInvitation(
      db,
      {
        mailAccountId: account.id,
        threadId,
        uid: "uid-1",
        recurrenceId: "",
        attendees: [RESPONDER],
      },
      new Date("2026-01-02T00:00:00Z"),
    );

    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(seriesRow?.attendees).toEqual([
      { email: "bob@example.com", name: "Bob", responseStatus: "accepted" },
    ]);

    const [threadRow] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(threadRow?.inInbox).toBe(false);
    expect(threadRow?.folderRole).toBe("archive");

    const notified = await listUndelivered(db, new Date("2026-01-02T00:03:01Z"));
    expect(notified).toHaveLength(1);
    expect(notified[0]?.payload).toMatchObject({
      kind: "calendar_answer",
      title: "Standup",
      answers: [{ attendeeEmail: "bob@example.com", responseStatus: "accepted" }],
    });
  });

  it("leaves the Thread and Series untouched when no organised Series shares the UID", async () => {
    const account = await createTestMailAccount(db);
    const threadId = await seedThreadAndInboxMessage(account.id);

    await applyAnswerInvitation(db, {
      mailAccountId: account.id,
      threadId,
      uid: "no-such-uid",
      recurrenceId: "",
      attendees: [RESPONDER],
    });

    const [threadRow] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(threadRow?.inInbox).toBe(true);
    expect(await listUndelivered(db)).toEqual([]);
  });

  it("leaves a fallback Series (an Invitation this User was invited to) untouched — organizerFirstSentAt is null", async () => {
    const account = await createTestMailAccount(db);
    const threadId = await seedThreadAndInboxMessage(account.id);
    await seedOrganizedSeries(account.userId, "uid-fallback", { organized: false });

    await applyAnswerInvitation(db, {
      mailAccountId: account.id,
      threadId,
      uid: "uid-fallback",
      recurrenceId: "",
      attendees: [RESPONDER],
    });

    const [threadRow] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(threadRow?.inInbox).toBe(true);
    expect(await listUndelivered(db)).toEqual([]);
  });

  it("leaves everything untouched when the RECURRENCE-ID names no real Occurrence", async () => {
    const account = await createTestMailAccount(db);
    const threadId = await seedThreadAndInboxMessage(account.id);
    await seedOrganizedSeries(account.userId, "uid-recur");

    await applyAnswerInvitation(db, {
      mailAccountId: account.id,
      threadId,
      uid: "uid-recur",
      recurrenceId: "2026-02-01T09:00:00.000Z",
      attendees: [RESPONDER],
    });

    const [threadRow] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(threadRow?.inInbox).toBe(true);
    expect(await listUndelivered(db)).toEqual([]);
  });

  it("leaves everything untouched when the answering address isn't one of the Series' own Attendees", async () => {
    const account = await createTestMailAccount(db);
    const threadId = await seedThreadAndInboxMessage(account.id);
    await seedOrganizedSeries(account.userId, "uid-stranger", {
      attendees: [{ email: "carol@example.com", name: "Carol", responseStatus: "needsAction" }],
    });

    await applyAnswerInvitation(db, {
      mailAccountId: account.id,
      threadId,
      uid: "uid-stranger",
      recurrenceId: "",
      attendees: [RESPONDER],
    });

    const [threadRow] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(threadRow?.inInbox).toBe(true);
    expect(await listUndelivered(db)).toEqual([]);
  });

  it("does nothing for a REPLY carrying no recognised PARTSTAT", async () => {
    const account = await createTestMailAccount(db);
    const threadId = await seedThreadAndInboxMessage(account.id);
    const seriesId = await seedOrganizedSeries(account.userId, "uid-needsaction");

    await applyAnswerInvitation(db, {
      mailAccountId: account.id,
      threadId,
      uid: "uid-needsaction",
      recurrenceId: "",
      attendees: [{ ...RESPONDER, partstat: "NEEDS-ACTION" }],
    });

    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(seriesRow?.attendees[0]?.responseStatus).toBe("needsAction");
    const [threadRow] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(threadRow?.inInbox).toBe(true);
  });

  it("still updates the Series and marks the Thread Done when the User's Answer notifications are off, but records no notification", async () => {
    const account = await createTestMailAccount(db);
    await db
      .update(users)
      .set({ answerNotificationsEnabled: false })
      .where(eq(users.id, account.userId));
    const threadId = await seedThreadAndInboxMessage(account.id);
    const seriesId = await seedOrganizedSeries(account.userId, "uid-quiet");

    await applyAnswerInvitation(db, {
      mailAccountId: account.id,
      threadId,
      uid: "uid-quiet",
      recurrenceId: "",
      attendees: [RESPONDER],
    });

    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(seriesRow?.attendees[0]?.responseStatus).toBe("accepted");
    const [threadRow] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(threadRow?.inInbox).toBe(false);
    expect(await listUndelivered(db, new Date(Date.now() + 10 * 60_000))).toEqual([]);
  });
});
