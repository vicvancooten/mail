import { randomUUID } from "node:crypto";
import { LOCAL_CALENDAR_CAPABILITIES } from "@mail/shared";
import { eq } from "drizzle-orm";
import type Mail from "nodemailer/lib/mailer/index.js";
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
import { getMailAccountById, type MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { answerLocalInvitation } from "./local-answer.js";
import { type AppendReplyToSent, sweepDueReplies } from "./reply-sweeper.js";

/**
 * The `imip_replies` sweep, end to end, with the mail server stood in for —
 * `compose/send-sweeper.test.ts`'s own shape: claim → submit → `Sent`
 * APPEND, and the three-way failure split reused from
 * `compose/submit.ts#classifyFailure`.
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

async function queueDueReply(): Promise<string> {
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

  const threadId = randomUUID();
  await db.insert(threads).values({ id: threadId, mailAccountId: account.id });
  await db.insert(folders).values({
    id: randomUUID(),
    mailAccountId: account.id,
    path: "INBOX",
    name: "INBOX",
    role: "inbox",
  });
  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.mailAccountId, account.id));
  const messageId = randomUUID();
  await db.insert(messages).values({
    id: messageId,
    mailAccountId: account.id,
    threadId,
    folderId: folder?.id ?? "",
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
    mailAccountId: account.id,
    messageId,
    threadId,
    kind: "request",
    method: "REQUEST",
    source: "ical",
    uid: "uid-1",
    recurrenceId: "",
    sequence: 1,
    dtstamp: new Date("2026-01-01T00:00:00Z"),
    organizer: { name: "Organiser", address: "organiser@example.com", role: null, partstat: null },
    attendees: [{ address: account.emailAddress, name: null, role: null, partstat: null }],
    vevent: null,
  });

  const answered = await answerLocalInvitation(db, account.userId, seriesId, "accepted");
  if (!answered.ok) throw new Error("expected ok");
  await db
    .update(imipReplies)
    .set({ submitAfter: new Date(0) })
    .where(eq(imipReplies.id, answered.replyId));
  return answered.replyId;
}

interface Recorder {
  transmitted: Mail.Options[];
  appended: { replyId: string; mime: string }[];
  appendToSent: AppendReplyToSent;
}

function recorder(): Recorder {
  const rec: Recorder = {
    transmitted: [],
    appended: [],
    appendToSent: async ({ row: reply, mime }) => {
      rec.appended.push({ replyId: reply.id, mime: mime.toString("utf8") });
    },
  };
  return rec;
}

function sweep(rec: Recorder, sendMail?: (options: Mail.Options) => Promise<unknown>) {
  return sweepDueReplies(db, (id) => getMailAccountById(db, id), {
    credentialKey: Buffer.alloc(32),
    appendToSent: rec.appendToSent,
    sendMail:
      sendMail ??
      (async (options) => {
        rec.transmitted.push(options);
      }),
  });
}

describe("sweepDueReplies", () => {
  it("submits a due Reply as a text/calendar; method=REPLY mail and appends it to Sent", async () => {
    const replyId = await queueDueReply();
    const rec = recorder();

    const result = await sweep(rec);

    expect(result).toMatchObject({ processed: 1, sent: 1 });
    expect(rec.transmitted).toHaveLength(1);
    expect(rec.transmitted[0]).toMatchObject({
      from: account.emailAddress,
      to: "organiser@example.com",
    });
    expect(rec.transmitted[0]?.icalEvent).toMatchObject({ method: "REPLY" });
    expect(rec.appended).toHaveLength(1);
    expect(rec.appended[0]?.mime).toContain("METHOD:REPLY");

    const [row] = await db.select().from(imipReplies).where(eq(imipReplies.id, replyId));
    expect(row?.status).toBe("sent");
  });

  it("retries a transient SMTP failure and leaves the Reply queued", async () => {
    await queueDueReply();
    const rec = recorder();

    const result = await sweep(rec, async () => {
      throw Object.assign(new Error("try again"), { responseCode: 450 });
    });

    expect(result).toMatchObject({ processed: 1, retried: 1 });
    const [row] = await db
      .select()
      .from(imipReplies)
      .where(eq(imipReplies.mailAccountId, account.id));
    expect(row?.status).toBe("submitting");
    expect(row?.nextAttemptAt).not.toBeNull();
  });

  it("a permanent SMTP rejection cancels the Reply rather than retrying forever", async () => {
    await queueDueReply();
    const rec = recorder();

    const result = await sweep(rec, async () => {
      throw Object.assign(new Error("rejected"), { responseCode: 550, response: "550 5.7.1 no" });
    });

    expect(result).toMatchObject({ processed: 1, failed: 1 });
    const [row] = await db
      .select()
      .from(imipReplies)
      .where(eq(imipReplies.mailAccountId, account.id));
    expect(row?.status).toBe("cancelled");
    expect(row?.sendError).toContain("550");
  });
});
