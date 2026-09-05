import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { mailAccounts, messages } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";
import { connectMailAccount } from "./imap-connection.js";
import { flushMutations } from "./mutations.js";
import { drainProtocolWrites } from "./protocol-writes.js";
import { syncMailAccount } from "./sync-account.js";

/**
 * The acceptance bar of #124 against a real Gmail account: Done removes the
 * `\Inbox` label rather than moving anything (Gmail's own INBOX listing
 * drops the message while All Mail keeps it), Undo adds the label back, and
 * Trash is still a real `MOVE` out of All Mail. GreenMail cannot exercise
 * any of this — no `X-GM-EXT-1`, no `[Gmail]/All Mail`
 * (`sync-plan.live-gmail.test.ts`'s own doc comment) — so this is skipped
 * unless a real Gmail account is configured, via the same
 * `GMAIL_LIVE_TEST_*` env vars that file uses.
 *
 * Uses a dedicated seeder `ImapFlow` client, independent of the Mail Account
 * under test, both to append the fixture message and to read Gmail's own
 * mailbox listings back afterwards — the same "never let the thing under
 * test also create its own fixtures" shape `sync-plan.live-gmail.test.ts`
 * follows.
 */
const EMAIL = process.env.GMAIL_LIVE_TEST_EMAIL ?? "";
const PASSWORD = process.env.GMAIL_LIVE_TEST_PASSWORD ?? "";
const HOST = process.env.GMAIL_LIVE_TEST_HOST ?? "imap.gmail.com";
const PORT = Number(process.env.GMAIL_LIVE_TEST_PORT ?? 993);

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let seeder: ImapFlow | null = null;

async function seederClient(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: EMAIL, pass: PASSWORD },
    logger: false,
  });
  await client.connect();
  seeder = client;
  return client;
}

/** Whether `path` currently lists a message carrying this `Message-ID`, per a fresh listing from `client`. */
async function mailboxHasMessage(
  client: ImapFlow,
  path: string,
  messageId: string,
): Promise<boolean> {
  const lock = await client.getMailboxLock(path);
  try {
    if (client.mailbox === false || client.mailbox.exists === 0) return false;
    for await (const message of client.fetch("1:*", { envelope: true })) {
      if (message.envelope?.messageId === `<${messageId}>`) return true;
    }
    return false;
  } finally {
    lock.release();
  }
}

beforeEach(async () => {
  if (!EMAIL) return;
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db, {
    emailAddress: EMAIL,
    password: PASSWORD,
    imapHost: HOST,
    imapPort: PORT,
  });
  const [updated] = await db
    .update(mailAccounts)
    .set({ imapSecurity: "tls", username: EMAIL })
    .where(eq(mailAccounts.id, account.id))
    .returning();
  if (updated) account = updated;
});

afterEach(async () => {
  await seeder?.logout().catch(() => undefined);
  seeder?.close();
  seeder = null;
});

afterAll(async () => {
  await closeDb?.();
});

async function ingestedMessage(messageId: string): Promise<{ threadId: string }> {
  const [row] = await db
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.mailAccountId, account.id), eq(messages.messageIdHeader, messageId)));
  if (!row) throw new Error("live Gmail sync did not ingest the seeded message");
  return row;
}

async function drainOnce(): Promise<number> {
  const client = await connectMailAccount(db, account, {
    credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
  });
  try {
    return await drainProtocolWrites(db, client, account.id);
  } finally {
    await client.logout().catch(() => undefined);
    client.close();
  }
}

describe.skipIf(!EMAIL || !PASSWORD)(
  "Done/Undo/Trash as Gmail Label operations against a real Gmail account (#124, ADR-0020)",
  () => {
    it("Done removes the message from Gmail's own INBOX listing while it stays in All Mail; Undo restores it", async () => {
      const messageId = `gmail-live-done-${Date.now()}@example.test`;
      const seed = await seederClient();
      await seed.append(
        "INBOX",
        buildTestMessage({
          from: "Alice Anderson <alice@example.test>",
          to: EMAIL,
          subject: "Live Gmail Done test",
          date: new Date(),
          messageId,
          text: "Hi.",
        }),
        [],
        new Date(),
      );

      await syncMailAccount(db, account, { mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });
      const { threadId } = await ingestedMessage(messageId);

      const outcomes = await flushMutations(db, account.id, [
        { id: randomUUID(), intent: { type: "archive", threadId } },
      ]);
      expect(outcomes[0]?.status).toBe("applied");
      expect(await drainOnce()).toBe(1);

      expect(await mailboxHasMessage(seed, "INBOX", messageId)).toBe(false);
      expect(await mailboxHasMessage(seed, "[Gmail]/All Mail", messageId)).toBe(true);

      const undoOutcomes = await flushMutations(db, account.id, [
        { id: randomUUID(), intent: { type: "restoreToInbox", threadId } },
      ]);
      expect(undoOutcomes[0]?.status).toBe("applied");
      expect(await drainOnce()).toBe(1);

      expect(await mailboxHasMessage(seed, "INBOX", messageId)).toBe(true);
    }, 30_000);

    it("Trash moves the message out of All Mail over a real IMAP MOVE", async () => {
      const messageId = `gmail-live-trash-${Date.now()}@example.test`;
      const seed = await seederClient();
      await seed.append(
        "INBOX",
        buildTestMessage({
          from: "Bob Baker <bob@example.test>",
          to: EMAIL,
          subject: "Live Gmail Trash test",
          date: new Date(),
          messageId,
          text: "Hi.",
        }),
        [],
        new Date(),
      );

      await syncMailAccount(db, account, { mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });
      const { threadId } = await ingestedMessage(messageId);

      const outcomes = await flushMutations(db, account.id, [
        { id: randomUUID(), intent: { type: "trash", threadId } },
      ]);
      expect(outcomes[0]?.status).toBe("applied");
      expect(await drainOnce()).toBe(1);

      expect(await mailboxHasMessage(seed, "[Gmail]/All Mail", messageId)).toBe(false);
      expect(await mailboxHasMessage(seed, "[Gmail]/Trash", messageId)).toBe(true);
    }, 30_000);
  },
);
