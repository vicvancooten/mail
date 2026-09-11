import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { invitations } from "../db/schema.js";
import { syncMailAccount } from "../sync/sync-account.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";

/**
 * The end-to-end acceptance bar of #239, ADR-0027, against a real IMAP
 * conversation (GreenMail, docs/dev-setup.md): an arriving Message carrying a
 * calendar attachment gets an Invitation row the moment its body is fetched.
 */
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);

const ORGANISER = "Alice Anderson <alice@example.test>";

const REQUEST_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:greenmail-evt-1@example.test",
  "DTSTAMP:20260101T120000Z",
  "DTSTART:20260105T140000Z",
  "DTEND:20260105T150000Z",
  "SEQUENCE:0",
  "SUMMARY:Quarterly review",
  "ORGANIZER:mailto:alice@example.test",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:owner@mail.test",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

let db: Db;
let closeDb: () => Promise<void>;

async function seedInvite(emailAddress: string): Promise<void> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: emailAddress, pass: "anything" },
    logger: false,
  });
  await client.connect();
  try {
    // Nested two levels deep: multipart/mixed > multipart/related >
    // multipart/alternative for the body, with the `.ics` as a real
    // (mixed-level) attachment — `buildTestMessage`'s own shape once any
    // attachment is present.
    await client.append(
      "INBOX",
      buildTestMessage({
        from: ORGANISER,
        to: emailAddress,
        subject: "Invitation: Quarterly review",
        date: new Date("2026-01-01T12:00:00Z"),
        messageId: "invite@example.test",
        text: "You're invited.",
        attachments: [
          {
            filename: "invite.ics",
            contentType: "text/calendar; method=REQUEST",
            content: REQUEST_ICS,
          },
        ],
      }),
      [],
      new Date("2026-01-01T12:00:00Z"),
    );
  } finally {
    await client.logout().catch(() => undefined);
    client.close();
  }
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

describe("Invitations parsed from arriving mail (#239) against GreenMail", () => {
  it("stores an Invitation for a REQUEST carried as a named .ics attachment", async () => {
    const emailAddress = `invite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mail.test`;
    await seedInvite(emailAddress);
    const account = await createTestMailAccount(db, {
      emailAddress,
      imapHost: IMAP_HOST,
      imapPort: IMAP_PORT,
    });

    const result = await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      fetchBodies: true,
    });
    expect(result.status).toBe("synced");

    const rows = await db
      .select()
      .from(invitations)
      .where(eq(invitations.mailAccountId, account.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "request",
      method: "REQUEST",
      source: "ical",
      uid: "greenmail-evt-1@example.test",
    });
    expect(rows[0]?.vevent).toMatchObject({ title: "Quarterly review" });
  });
});
