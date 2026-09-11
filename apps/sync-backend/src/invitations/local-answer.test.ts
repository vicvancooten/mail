import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import {
  calendars,
  folders,
  imipReplies,
  invitations,
  messages,
  series,
  threads,
} from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  answerLocalInvitation,
  cancelLocalReply,
  claimReply,
  dueReplyCandidateIds,
} from "./local-answer.js";

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

async function seedLocalSeries(
  userId: string,
  mailAccountId: string,
  selfEmail: string,
): Promise<{ seriesId: string; calendarId: string }> {
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
    mailAccountId,
    mirrored: true,
    capabilities: LOCAL_CALENDAR_CAPABILITIES,
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
    uid: "uid-1",
    recurrenceId: "",
    sequence: 3,
    dtstamp: new Date("2026-01-01T00:00:00Z"),
    organizer: { name: "Organiser", address: "organiser@example.com", role: null, partstat: null },
    attendees: [{ address: selfEmail, name: null, role: null, partstat: null }],
    vevent: null,
  });
  return { seriesId, calendarId };
}

describe("answerLocalInvitation", () => {
  it("updates the Series' Attendee entry and queues a pending Reply", async () => {
    const account = await createTestMailAccount(db);
    const { seriesId } = await seedLocalSeries(account.userId, account.id, account.emailAddress);

    const result = await answerLocalInvitation(db, account.userId, seriesId, "accepted");
    expect(result).toMatchObject({ ok: true, previousResponseStatus: "needsAction" });

    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(seriesRow?.attendees[0]?.responseStatus).toBe("accepted");

    if (!result.ok) throw new Error("expected ok");
    const [reply] = await db.select().from(imipReplies).where(eq(imipReplies.id, result.replyId));
    expect(reply).toMatchObject({
      status: "pending",
      responseStatus: "accepted",
      organizerAddress: "organiser@example.com",
      attendeeAddress: account.emailAddress,
      sequence: 3,
    });
    expect(reply?.icsText).toContain("METHOD:REPLY");
    expect(reply?.icsText).toContain("PARTSTAT=ACCEPTED");
  });

  it("supersedes an earlier still-pending Reply for the same Series", async () => {
    const account = await createTestMailAccount(db);
    const { seriesId } = await seedLocalSeries(account.userId, account.id, account.emailAddress);

    const first = await answerLocalInvitation(db, account.userId, seriesId, "tentative");
    const second = await answerLocalInvitation(db, account.userId, seriesId, "accepted");
    if (!first.ok || !second.ok) throw new Error("expected both to succeed");

    const [firstRow] = await db.select().from(imipReplies).where(eq(imipReplies.id, first.replyId));
    const [secondRow] = await db
      .select()
      .from(imipReplies)
      .where(eq(imipReplies.id, second.replyId));
    expect(firstRow?.status).toBe("cancelled");
    expect(secondRow?.status).toBe("pending");
  });

  it("404s series_not_found for an id nobody owns", async () => {
    const account = await createTestMailAccount(db);
    const result = await answerLocalInvitation(db, account.userId, randomUUID(), "accepted");
    expect(result).toEqual({ ok: false, reason: "series_not_found" });
  });

  it("rejects not_local for a synced Calendar's Series", async () => {
    const account = await createTestMailAccount(db);
    const calendarId = `gcal:${account.connectedAccountId}:${randomUUID()}`;
    await db.insert(calendars).values({
      id: calendarId,
      userId: account.userId,
      name: "Mirrored",
      description: null,
      timeZone: "UTC",
      originType: "connectedAccount",
      connectedAccountId: account.connectedAccountId,
      color: "#4285F4",
      isDefault: false,
      mailAccountId: null,
      mirrored: true,
      capabilities: { ...LOCAL_CALENDAR_CAPABILITIES, writable: true },
    });
    const seriesId = randomUUID();
    await db.insert(series).values({
      id: seriesId,
      userId: account.userId,
      calendarId,
      uid: "uid-1",
      title: "Standup",
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      durationMs: 30 * 60 * 1000,
      transparency: "opaque",
      attendees: [{ email: account.emailAddress, name: null, responseStatus: "needsAction" }],
    });

    const result = await answerLocalInvitation(db, account.userId, seriesId, "accepted");
    expect(result).toEqual({ ok: false, reason: "not_local" });
  });

  it("rejects not_attendee when the Series carries no Attendee entry for this Mail Account", async () => {
    const account = await createTestMailAccount(db);
    const { seriesId } = await seedLocalSeries(
      account.userId,
      account.id,
      "someone-else@example.com",
    );

    const result = await answerLocalInvitation(db, account.userId, seriesId, "accepted");
    expect(result).toEqual({ ok: false, reason: "not_attendee" });
  });
});

describe("cancelLocalReply", () => {
  it("cancels a pending Reply and reverts the Series' Attendee entry", async () => {
    const account = await createTestMailAccount(db);
    const { seriesId } = await seedLocalSeries(account.userId, account.id, account.emailAddress);
    const answered = await answerLocalInvitation(db, account.userId, seriesId, "declined");
    if (!answered.ok) throw new Error("expected ok");

    const result = await cancelLocalReply(db, account.userId, answered.replyId, "needsAction");
    expect(result).toEqual({ ok: true });

    const [reply] = await db.select().from(imipReplies).where(eq(imipReplies.id, answered.replyId));
    expect(reply?.status).toBe("cancelled");

    const [seriesRow] = await db.select().from(series).where(eq(series.id, seriesId));
    expect(seriesRow?.attendees[0]?.responseStatus).toBe("needsAction");
  });

  it("too_late once the Reply is no longer pending", async () => {
    const account = await createTestMailAccount(db);
    const { seriesId } = await seedLocalSeries(account.userId, account.id, account.emailAddress);
    const answered = await answerLocalInvitation(db, account.userId, seriesId, "accepted");
    if (!answered.ok) throw new Error("expected ok");
    await db
      .update(imipReplies)
      .set({ status: "sent" })
      .where(eq(imipReplies.id, answered.replyId));

    const result = await cancelLocalReply(db, account.userId, answered.replyId, "needsAction");
    expect(result).toEqual({ ok: false, reason: "too_late" });
  });

  it("not_found for a Reply id nobody owns", async () => {
    const account = await createTestMailAccount(db);
    const result = await cancelLocalReply(db, account.userId, randomUUID(), "needsAction");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("the due-Reply sweeper candidates", () => {
  it("a freshly-queued Reply is not due until its submitAfter passes", async () => {
    const account = await createTestMailAccount(db);
    const { seriesId } = await seedLocalSeries(account.userId, account.id, account.emailAddress);
    const answered = await answerLocalInvitation(db, account.userId, seriesId, "accepted");
    if (!answered.ok) throw new Error("expected ok");

    expect(await dueReplyCandidateIds(db, new Date())).not.toContain(answered.replyId);
    const later = new Date(Date.now() + 60_000);
    expect(await dueReplyCandidateIds(db, later)).toContain(answered.replyId);

    const claimed = await claimReply(db, answered.replyId, () => "msg-id@example.com", later);
    expect(claimed?.status).toBe("submitting");
    expect(claimed?.messageId).toBe("msg-id@example.com");
  });
});
