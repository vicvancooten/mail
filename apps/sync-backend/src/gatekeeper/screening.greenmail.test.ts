import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { messages, threads } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import { getMailAccountById, type MailAccountRow } from "../mail-accounts/store.js";
import { listUndelivered } from "../notifier/outbox.js";
import { applyFolderDelta } from "../sync/delta.js";
import { type FolderRow, findFolderByRole } from "../sync/folders.js";
import { connectMailAccount } from "../sync/imap-connection.js";
import { drainProtocolWrites } from "../sync/protocol-writes.js";
import { syncMailAccount } from "../sync/sync-account.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";
import { enableGatekeeper } from "./settings.js";
import { setVerdict } from "./verdicts.js";

/**
 * ADR-0008's own acceptance sentence, end to end against GreenMail: "when
 * mail from a Blocked Sender arrives, the Sync Backend moves it to the Mail
 * Account's `\Trash` folder before it ever surfaces in the Client", and
 * "the move is visible to every other IMAP client against the same Mail
 * Account".
 *
 * Both halves are checked from a **second connection** standing in for
 * another mail client — the same pattern `protocol-writes.greenmail.test.ts`
 * uses, and the only way to tell a real `MOVE` apart from a row this backend
 * merely relabelled.
 */
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let otherClient: ImapFlow | null = null;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  const emailAddress = `gatekeeper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mail.test`;
  account = await createTestMailAccount(db, {
    emailAddress,
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
  });
});

afterEach(async () => {
  await otherClient?.logout().catch(() => undefined);
  otherClient?.close();
  otherClient = null;
});

afterAll(async () => {
  await closeDb?.();
});

/** A second IMAP connection standing in for "another mail client" against the same mailbox. */
async function connectOtherClient(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: account.emailAddress, pass: "anything" },
    logger: false,
  });
  await client.connect();
  otherClient = client;
  return client;
}

async function inboxRow(): Promise<FolderRow> {
  const row = await findFolderByRole(db, account.id, "inbox");
  if (!row) throw new Error("INBOX was not discovered");
  return row;
}

async function reloadAccount(): Promise<MailAccountRow> {
  const row = await getMailAccountById(db, account.id);
  if (!row) throw new Error("account vanished");
  account = row;
  return row;
}

async function deliverToInbox(
  other: ImapFlow,
  from: string,
  subject: string,
  options: { deliveredTo?: string } = {},
): Promise<void> {
  await other.append(
    "INBOX",
    buildTestMessage({
      from,
      to: account.emailAddress,
      deliveredTo: options.deliveredTo,
      subject,
      date: new Date(),
      messageId: `${Math.random().toString(36).slice(2)}@example.test`,
      text: "Body.",
    }),
    [],
    new Date(),
  );
}

/** Runs the live delta over INBOX, then drains whatever protocol writes it queued. */
async function syncAndDrain(): Promise<void> {
  const client = await connectMailAccount(db, account, {
    credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
  });
  try {
    await applyFolderDelta(db, client, await inboxRow());
    await drainProtocolWrites(db, client, account.id);
  } finally {
    await client.logout().catch(() => undefined);
    client.close();
  }
}

/** What a folder holds right now, per a fresh `SELECT` on the other client. */
async function subjectsIn(client: ImapFlow, path: string): Promise<string[]> {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  const subjects: string[] = [];
  try {
    if (client.mailbox === false || client.mailbox.exists === 0) return subjects;
    for await (const message of client.fetch("1:*", { envelope: true })) {
      subjects.push(message.envelope?.subject ?? "");
    }
  } finally {
    lock.release();
  }
  return subjects;
}

describe("Gatekeeper against GreenMail (#55, ADR-0008)", () => {
  it("moves a Blocked Sender's arriving mail to the real \\Trash, visibly to another IMAP client", async () => {
    const other = await connectOtherClient();
    await other.mailboxCreate("Trash");

    // Baseline: folders discovered, INBOX established. Gatekeeper is enabled
    // after this so the Cutoff genuinely precedes the arrival below.
    await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      roles: ["inbox", "trash"],
    });
    await enableGatekeeper(db, account.id);
    await reloadAccount();
    await setVerdict(
      db,
      account.id,
      { scope: "address", value: "villain@example.test" },
      "blocked",
      "screener",
    );

    await deliverToInbox(other, "The Villain <villain@example.test>", "Blocked on arrival");
    await syncAndDrain();

    // The other client's own view of the mailbox — the ADR's "visible to
    // every other IMAP client" clause, checked the only way it can be.
    expect(await subjectsIn(other, "INBOX")).toEqual([]);
    expect(await subjectsIn(other, "Trash")).toEqual(["Blocked on arrival"]);

    // And it never surfaced: out of the Inbox synchronously, no push.
    const [thread] = await db.select().from(threads).where(eq(threads.mailAccountId, account.id));
    expect(thread?.inInbox).toBe(false);
    expect(thread?.heldSender).toBeNull();
    expect(await listUndelivered(db)).toEqual([]);
  });

  it("leaves an Unscreened stranger's mail exactly where it is, held only in this backend", async () => {
    const other = await connectOtherClient();
    await other.mailboxCreate("Trash");
    await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      roles: ["inbox", "trash"],
    });
    await enableGatekeeper(db, account.id);
    await reloadAccount();

    await deliverToInbox(other, "A Stranger <stranger@example.test>", "Held, not moved");
    await syncAndDrain();

    // The Screening Hold is an App Feature: nothing on the server moved.
    expect(await subjectsIn(other, "INBOX")).toEqual(["Held, not moved"]);
    expect(await subjectsIn(other, "Trash")).toEqual([]);

    const [thread] = await db.select().from(threads).where(eq(threads.mailAccountId, account.id));
    expect(thread?.heldSender).toBe("stranger@example.test");
    expect(thread?.inInbox).toBe(true);
    expect((await listUndelivered(db)).map((row) => row.kind)).toEqual(["gatekeeper_digest"]);
  });

  it("resolves the Alias from Delivered-To at ingest, and Block Alias trashes a future arrival there — beating even an Approved Sender (#103)", async () => {
    const other = await connectOtherClient();
    await other.mailboxCreate("Trash");
    await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
      roles: ["inbox", "trash"],
    });
    await enableGatekeeper(db, account.id);
    await reloadAccount();

    const alias = `sales@${account.emailAddress.split("@")[1]}`;
    await setVerdict(
      db,
      account.id,
      { scope: "address", value: "colleague@partner.test" },
      "approved",
      "seed",
    );

    await deliverToInbox(other, "Colleague <colleague@partner.test>", "Not yet blocked", {
      deliveredTo: alias,
    });
    await syncAndDrain();

    // Resolved and stored per message at ingest (#103), before any Verdict
    // exists for the Alias — an Approved Sender's mail still lands normally.
    const [firstMessage] = await db
      .select()
      .from(messages)
      .where(eq(messages.mailAccountId, account.id));
    expect(firstMessage?.recipientAlias).toBe(alias);
    expect(await subjectsIn(other, "INBOX")).toEqual(["Not yet blocked"]);

    await setVerdict(db, account.id, { scope: "recipient", value: alias }, "blocked", "screener");

    await deliverToInbox(other, "Colleague <colleague@partner.test>", "Blocked by Alias", {
      deliveredTo: alias,
    });
    await syncAndDrain();

    // Beats the Approved Sender Verdict: the earlier mail stays put, the new
    // arrival at the now-Blocked Alias moves to the real \Trash.
    expect(await subjectsIn(other, "INBOX")).toEqual(["Not yet blocked"]);
    expect(await subjectsIn(other, "Trash")).toEqual(["Blocked by Alias"]);
  });
});
