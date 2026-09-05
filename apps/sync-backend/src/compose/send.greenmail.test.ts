import { randomUUID } from "node:crypto";
import type { ComposeDocument } from "@mail/shared";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { attachmentBlobs, compositions, folders } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import { getMailAccountById, type MailAccountRow } from "../mail-accounts/store.js";
import { pushDraftsForAccount } from "../sync/draft-push.js";
import { connectMailAccount } from "../sync/imap-connection.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { putBlob } from "./blob-store.js";
import { acceptSend, cancelSend } from "./pending-send.js";
import { imapSentWriter, sweepDueSends } from "./send-sweeper.js";

/**
 * The ticket's own acceptance line — "sent mail appears in the Sent folder in
 * another IMAP client" — against real SMTP and real IMAP (GreenMail,
 * docs/dev-setup.md), plus ADR-0012's lifecycle step: the draft's IMAP copy is
 * expunged in the same step that APPENDs to `Sent`.
 *
 * GreenMail accepts every credential and every message, so this covers the
 * happy path only; the failure classification and the retry are
 * `send-sweeper.test.ts`'s, with an injected transport.
 */

const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);
const SMTP_PORT = Number(process.env.SMTP_TEST_PORT ?? 3025);

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let other: ImapFlow | null = null;

const DOC: ComposeDocument = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Sent over real SMTP." }] }],
};

beforeEach(async () => {
  await closeDb?.();
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db, {
    emailAddress: `send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mail.test`,
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
    smtpPort: SMTP_PORT,
  });
});

afterEach(async () => {
  await other?.logout().catch(() => undefined);
  other?.close();
  other = null;
});

afterAll(async () => {
  await closeDb?.();
});

/** A second IMAP client against the same mailbox — the "another IMAP client" of the acceptance line. */
async function connectOther(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: account.emailAddress, pass: "anything" },
    logger: false,
  });
  await client.connect();
  other = client;
  return client;
}

async function seedFolder(o: ImapFlow, path: string, role: "sent" | "drafts"): Promise<void> {
  await o.mailboxCreate(path);
  await db
    .insert(folders)
    .values({ id: randomUUID(), mailAccountId: account.id, path, name: path, role });
}

async function insertSend(delaySeconds = 0, subject = "Real send"): Promise<string> {
  const id = randomUUID();
  await db.insert(compositions).values({
    id,
    mailAccountId: account.id,
    subject,
    document: DOC,
    toAddresses: [{ name: null, address: account.emailAddress }],
    ccAddresses: [],
    bccAddresses: [{ name: null, address: `bcc-${randomUUID()}@mail.test` }],
    version: 1,
    updatedAt: new Date(Date.now() - 60_000),
  });
  await acceptSend(db, account.id, id, delaySeconds);
  return id;
}

async function realSweep() {
  const credentialKey = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
  return sweepDueSends(db, (id) => getMailAccountById(db, id), {
    credentialKey,
    appendToSent: imapSentWriter(db, credentialKey),
  });
}

async function sourcesIn(client: ImapFlow, path: string): Promise<string[]> {
  const status = await client.status(path, { messages: true });
  if ((status.messages ?? 0) === 0) return [];
  const lock = await client.getMailboxLock(path);
  const sources: string[] = [];
  try {
    for await (const message of client.fetch("1:*", { source: true })) {
      sources.push(message.source?.toString("utf8") ?? "");
    }
  } finally {
    lock.release();
  }
  return sources;
}

describe("the send path against GreenMail", () => {
  it("submits over SMTP and the sent mail is readable in Sent from another IMAP client", async () => {
    const o = await connectOther();
    await seedFolder(o, "Sent", "sent");
    const id = await insertSend(0, "Dinner on Friday");

    expect(await realSweep()).toMatchObject({ sent: 1 });

    const [row] = await db.select().from(compositions).where(eq(compositions.id, id));
    expect(row?.status).toBe("sent");
    const mintedId = row?.messageId;
    expect(mintedId).toBeTruthy();

    const sent = await sourcesIn(o, "Sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Dinner on Friday");
    expect(sent[0]).toContain(`<${mintedId}>`);
    expect(sent[0]).toMatch(/Content-Type:\s*multipart\/alternative/i);
    // Bcc is visible in the User's own copy, and only there.
    expect(sent[0]).toMatch(/^Bcc:/m);

    // And the message actually travelled: GreenMail delivered it to the same
    // address's INBOX, carrying the Sync Backend's minted id — with no Bcc
    // header on the copy that went over the wire.
    const delivered = await sourcesIn(o, "INBOX");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(`<${mintedId}>`);
    expect(delivered[0]).not.toMatch(/^Bcc:/m);
  });

  it("carries three dropped attachments intact over real SMTP, and drops the blobs once sent (#48)", async () => {
    const o = await connectOther();
    await seedFolder(o, "Sent", "sent");
    const id = await insertSend(0, "Three files attached");

    for (const file of [
      { filename: "report.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 fake") },
      {
        filename: "notes.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("hello from a text file"),
      },
      { filename: "photo.png", mimeType: "image/png", bytes: Buffer.from("fake png bytes") },
    ]) {
      const result = await putBlob(db, {
        compositionId: id,
        mailAccountId: account.id,
        bytes: file.bytes,
        filename: file.filename,
        mimeType: file.mimeType,
        disposition: "attachment",
        budgetBytes: 25 * 1024 * 1024,
      });
      expect(result.ok).toBe(true);
    }
    expect(await db.select().from(attachmentBlobs)).toHaveLength(3);

    expect(await realSweep()).toMatchObject({ sent: 1 });

    const sent = await sourcesIn(o, "Sent");
    expect(sent).toHaveLength(1);
    const mime = sent[0] ?? "";
    expect(mime).toMatch(/Content-Type:\s*multipart\/mixed/i);
    expect(mime).toContain("filename=report.pdf");
    expect(mime).toContain("filename=notes.txt");
    expect(mime).toContain("filename=photo.png");
    // Base64-decodable proof the bytes themselves made the trip, not just the filenames.
    expect(mime).toContain(Buffer.from("hello from a text file").toString("base64"));

    // ADR-0012's lifecycle: blobs are gone from Postgres once the send succeeds.
    expect(await db.select().from(attachmentBlobs)).toEqual([]);
    const [row] = await db.select().from(compositions).where(eq(compositions.id, id));
    expect(row?.status).toBe("sent");
  });

  it("keeps the blobs with the Draft when a send is cancelled instead of completed (#48)", async () => {
    const id = await insertSend(30, "Cancel me");
    const result = await putBlob(db, {
      compositionId: id,
      mailAccountId: account.id,
      bytes: Buffer.from("keep me"),
      filename: "keep.txt",
      mimeType: "text/plain",
      disposition: "attachment",
      budgetBytes: 25 * 1024 * 1024,
    });
    expect(result.ok).toBe(true);

    expect(await cancelSend(db, account.id, id)).toEqual({ status: "cancelled" });

    expect(await db.select().from(attachmentBlobs)).toHaveLength(1);
    const [row] = await db.select().from(compositions).where(eq(compositions.id, id));
    expect(row?.status).toBe("draft");
    expect(row?.attachments).toHaveLength(1);
  });

  it("expunges the draft's IMAP copy in the same step that APPENDs to Sent (ADR-0012)", async () => {
    const o = await connectOther();
    await seedFolder(o, "Sent", "sent");
    await seedFolder(o, "Drafts", "drafts");
    const id = await insertSend(0, "Was a draft");

    // Export the draft the way the debounced push would, so there is a real
    // UID for the send to clean up.
    const client = await connectMailAccount(db, account, {
      credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
    });
    try {
      // Back to an idle Draft so the debounced push will actually export it
      // (`acceptSend` bumped `updatedAt` inside the 30s idle window).
      await db
        .update(compositions)
        .set({ status: "draft", submitAfter: null, updatedAt: new Date(Date.now() - 60_000) })
        .where(eq(compositions.id, id));
      expect(
        await pushDraftsForAccount(db, client, account.id, account.emailAddress),
      ).toMatchObject({ pushed: 1 });
      await acceptSend(db, account.id, id, 0);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }
    expect(await sourcesIn(o, "Drafts")).toHaveLength(1);

    expect(await realSweep()).toMatchObject({ sent: 1 });

    expect(await sourcesIn(o, "Drafts")).toHaveLength(0);
    expect(await sourcesIn(o, "Sent")).toHaveLength(1);
    const [row] = await db.select().from(compositions).where(eq(compositions.id, id));
    expect(row?.imapDraftUid).toBeNull();
  });

  it("still sends when the account has no Sent folder — discovery degrades, it never creates one", async () => {
    const o = await connectOther();
    await insertSend(0, "No Sent folder here");

    expect(await realSweep()).toMatchObject({ sent: 1 });

    // The mail went out; nothing invented a folder on the User's mail server.
    expect(await sourcesIn(o, "INBOX")).toHaveLength(1);
    await expect(o.status("Sent", { messages: true })).rejects.toThrow();
  });

  it("skips the Sent APPEND on a Gmail account, but the send still completes (ADR-0020, #123)", async () => {
    account = await createTestMailAccount(db, {
      serverKind: "gmail",
      emailAddress: `send-gmail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mail.test`,
      imapHost: IMAP_HOST,
      imapPort: IMAP_PORT,
      smtpPort: SMTP_PORT,
    });
    const o = await connectOther();
    await seedFolder(o, "Sent", "sent");
    const id = await insertSend(0, "Gmail files its own Sent copy");

    expect(await realSweep()).toMatchObject({ sent: 1 });

    const [row] = await db.select().from(compositions).where(eq(compositions.id, id));
    expect(row?.status).toBe("sent");
    // GreenMail files one Sent copy for this SMTP submit; the Sync Backend
    // must not add a second APPEND copy. The Bcc/header split itself is
    // unit-covered in `submit.test.ts`; this integration seam only proves the
    // Gmail path skips the extra APPEND.
    const sent = await sourcesIn(o, "Sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].split(/\r?\n/)).toContain(`Message-ID: <${row?.messageId}>`);
    expect(await sourcesIn(o, "INBOX")).toHaveLength(1);
  });
});
