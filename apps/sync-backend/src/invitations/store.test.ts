import { randomUUID } from "node:crypto";
import type { ImapFlow } from "imapflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, invitations, type MessageAttachment, messages } from "../db/schema.js";
import { resolveThread } from "../sync/threading.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { extractInvitations, latestInvitationRevision } from "./store.js";

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

const REQUEST_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:evt-1@example.com",
  "DTSTAMP:20260101T120000Z",
  "DTSTART:20260105T140000Z",
  "DTEND:20260105T150000Z",
  "SEQUENCE:0",
  "SUMMARY:Weekly sync",
  "ORGANIZER:mailto:alice@example.com",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

/** A fake `ImapFlow` whose `fetchOne` hands back one part's raw bytes — the shape `store.ts#fetchPartBytes` (and `routes/messages.ts#fetchAttachmentBytes`) fetches through. */
function fakeClient(partsByUid: Map<number, Map<string, Buffer>>): ImapFlow {
  const fake = {
    async fetchOne(uid: string) {
      const bodyParts = partsByUid.get(Number(uid));
      return bodyParts ? { bodyParts } : null;
    },
  };
  return fake as unknown as ImapFlow;
}

async function seedMessage(): Promise<{
  mailAccountId: string;
  messageId: string;
  threadId: string;
  folderId: string;
}> {
  const account = await createTestMailAccount(db);
  const folderId = randomUUID();
  await db.insert(folders).values({
    id: folderId,
    mailAccountId: account.id,
    path: "INBOX",
    name: "INBOX",
    role: "inbox",
  });
  const receivedAt = new Date("2026-01-01T00:00:00Z");
  const threadId = await resolveThread(db, {
    mailAccountId: account.id,
    threadingIds: [randomUUID()],
    subject: "Weekly sync",
    receivedAt,
  });
  const messageId = randomUUID();
  await db.insert(messages).values({
    id: messageId,
    mailAccountId: account.id,
    threadId,
    folderId,
    uid: 1,
    subject: "Weekly sync",
    sentAt: receivedAt,
    receivedAt,
  });
  return { mailAccountId: account.id, messageId, threadId, folderId };
}

function icsAttachment(part: string): MessageAttachment {
  return {
    part,
    filename: "invite.ics",
    mimeType: "text/calendar",
    sizeBytes: null,
    contentId: null,
    inline: false,
    encoding: null,
  };
}

describe("extractInvitations", () => {
  it("stores an Invitation from a text/calendar attachment", async () => {
    const { mailAccountId, messageId, threadId } = await seedMessage();
    const client = fakeClient(new Map([[1, new Map([["2", Buffer.from(REQUEST_ICS)]])]]));

    await extractInvitations(
      db,
      client,
      1,
      { id: messageId, threadId, mailAccountId, fallbackDtstamp: new Date("2026-01-01T00:00:00Z") },
      [icsAttachment("2")],
    );

    const rows = await db.select().from(invitations);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      messageId,
      threadId,
      mailAccountId,
      kind: "request",
      method: "REQUEST",
      source: "ical",
      uid: "evt-1@example.com",
      recurrenceId: "",
      sequence: 0,
    });
    expect(rows[0]?.organizer).toEqual({
      address: "alice@example.com",
      name: null,
      role: null,
      partstat: null,
    });
  });

  it("treats an inline calendar part plus a named .ics as one Invitation, not two", async () => {
    const { mailAccountId, messageId, threadId } = await seedMessage();
    const client = fakeClient(
      new Map([
        [
          1,
          new Map([
            ["2", Buffer.from(REQUEST_ICS)],
            ["3", Buffer.from(REQUEST_ICS)],
          ]),
        ],
      ]),
    );

    await extractInvitations(
      db,
      client,
      1,
      { id: messageId, threadId, mailAccountId, fallbackDtstamp: new Date() },
      [icsAttachment("2"), icsAttachment("3")],
    );

    const rows = await db.select().from(invitations);
    expect(rows).toHaveLength(1);
  });

  it("is a no-op with no IMAP round trip when nothing looks like an Invitation", async () => {
    const { mailAccountId, messageId, threadId } = await seedMessage();
    const client = {
      async fetchOne() {
        throw new Error("must not be called");
      },
    } as unknown as ImapFlow;

    await extractInvitations(
      db,
      client,
      1,
      { id: messageId, threadId, mailAccountId, fallbackDtstamp: new Date() },
      [
        {
          part: "2",
          filename: "photo.png",
          mimeType: "image/png",
          sizeBytes: 100,
          contentId: null,
          inline: false,
          encoding: null,
        },
      ],
    );

    const rows = await db.select().from(invitations);
    expect(rows).toHaveLength(0);
  });

  it("finds a calendar part by filename when the server mislabels its MIME type", async () => {
    const { mailAccountId, messageId, threadId } = await seedMessage();
    const client = fakeClient(new Map([[1, new Map([["2", Buffer.from(REQUEST_ICS)]])]]));

    await extractInvitations(
      db,
      client,
      1,
      { id: messageId, threadId, mailAccountId, fallbackDtstamp: new Date() },
      [
        {
          part: "2",
          filename: "invite.ics",
          mimeType: "application/octet-stream",
          sizeBytes: null,
          contentId: null,
          inline: false,
          encoding: null,
        },
      ],
    );

    const rows = await db.select().from(invitations);
    expect(rows).toHaveLength(1);
  });
});

describe("latestInvitationRevision", () => {
  it("orders one UID's revisions by SEQUENCE then DTSTAMP (ADR-0027)", async () => {
    const { mailAccountId, messageId, threadId, folderId } = await seedMessage();
    const newerSequence = REQUEST_ICS.replace("SEQUENCE:0", "SEQUENCE:2").replace(
      "DTSTAMP:20260101T120000Z",
      "DTSTAMP:20260101T090000Z",
    );
    const client = fakeClient(new Map([[1, new Map([["2", Buffer.from(REQUEST_ICS)]])]]));
    await extractInvitations(
      db,
      client,
      1,
      { id: messageId, threadId, mailAccountId, fallbackDtstamp: new Date() },
      [icsAttachment("2")],
    );

    // A second Message in the same Thread carries the next revision — same
    // UID, higher SEQUENCE — and must sort ahead of the first despite an
    // earlier DTSTAMP.
    const secondMessageId = randomUUID();
    await db.insert(messages).values({
      id: secondMessageId,
      mailAccountId,
      threadId,
      folderId,
      uid: 2,
      subject: "Weekly sync",
      sentAt: new Date(),
      receivedAt: new Date(),
    });
    const secondClient = fakeClient(new Map([[2, new Map([["2", Buffer.from(newerSequence)]])]]));
    await extractInvitations(
      db,
      secondClient,
      2,
      { id: secondMessageId, threadId, mailAccountId, fallbackDtstamp: new Date() },
      [icsAttachment("2")],
    );

    const latest = await latestInvitationRevision(db, threadId, "evt-1@example.com");
    expect(latest?.sequence).toBe(2);
    expect(latest?.messageId).toBe(secondMessageId);
  });
});
