import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, messages } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { updateMailAccountNotificationsEnabled } from "../mail-accounts/store.js";
import type { FolderRow } from "../sync/folders.js";
import { resolveThread } from "../sync/threading.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { listUndelivered } from "./outbox.js";
import {
  recordFailedSendNotification,
  recordNeedsReauthNotification,
  recordNewMailNotifications,
} from "./record.js";

/**
 * `notifier/record.ts` against a real Postgres — every function here is a
 * thin insert wrapped around a policy gate, and the gate (the per-Mail-Account
 * toggle, Inbox-only) is exactly what's worth proving against real rows
 * rather than a fake.
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

async function seedFolder(role: FolderRow["role"], path: string): Promise<FolderRow> {
  const id = randomUUID();
  const [row] = await db
    .insert(folders)
    .values({ id, mailAccountId: account.id, path, name: path, role })
    .returning();
  if (!row) throw new Error("folder insert returned no row");
  return row;
}

/** One Message stored the way `ingest.ts#storeMessage` would have, minus everything `recordNewMailNotifications` doesn't read. */
async function seedMessage(
  folder: FolderRow,
  overrides: {
    subject?: string;
    fromName?: string | null;
    fromAddress?: string | null;
    snippet?: string | null;
  } = {},
): Promise<string> {
  const threadId = await resolveThread(db, {
    mailAccountId: account.id,
    threadingIds: [randomUUID()],
    subject: overrides.subject ?? "Test",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
  });
  const id = randomUUID();
  await db.insert(messages).values({
    id,
    mailAccountId: account.id,
    threadId,
    folderId: folder.id,
    uid: 1,
    subject: overrides.subject ?? "Test",
    fromName: overrides.fromName ?? "Alice",
    fromAddress: overrides.fromAddress ?? "alice@example.com",
    snippet: overrides.snippet ?? null,
    sentAt: new Date("2026-01-01T00:00:00Z"),
    receivedAt: new Date("2026-01-01T00:00:00Z"),
  });
  return id;
}

describe("recordNewMailNotifications", () => {
  it("records a new_mail entry for a message that landed in the Inbox", async () => {
    const inbox = await seedFolder("inbox", "INBOX");
    const messageId = await seedMessage(inbox, {
      subject: "Hi",
      fromName: "Bob",
      fromAddress: "bob@x.test",
    });

    await recordNewMailNotifications(db, inbox, account, [messageId]);

    const [entry] = await listUndelivered(db);
    expect(entry?.kind).toBe("new_mail");
    expect(entry?.payload).toMatchObject({
      kind: "new_mail",
      senderName: "Bob",
      senderAddress: "bob@x.test",
      subject: "Hi",
    });
  });

  it("never records anything for a non-Inbox folder — the simulated Approved-Sender check", async () => {
    const archive = await seedFolder("archive", "Archive");
    const messageId = await seedMessage(archive);

    await recordNewMailNotifications(db, archive, account, [messageId]);

    expect(await listUndelivered(db)).toEqual([]);
  });

  it("never records anything when the Mail Account's notification toggle is off (#54)", async () => {
    await updateMailAccountNotificationsEnabled(db, account.id, false);
    const inbox = await seedFolder("inbox", "INBOX");
    const messageId = await seedMessage(inbox);

    await recordNewMailNotifications(db, inbox, { ...account, notificationsEnabled: false }, [
      messageId,
    ]);

    expect(await listUndelivered(db)).toEqual([]);
  });

  it("is a no-op for an empty message list — no account lookup, no query", async () => {
    const inbox = await seedFolder("inbox", "INBOX");
    await recordNewMailNotifications(db, inbox, account, []);
    expect(await listUndelivered(db)).toEqual([]);
  });

  describe("on Gmail (#125, ADR-0020)", () => {
    /** One Message stored on All Mail (role "all"), the way #122's Gmail ingest would have. */
    async function seedGmailMessage(
      allMail: FolderRow,
      gmailLabels: string[] | null,
    ): Promise<string> {
      const threadId = await resolveThread(db, {
        mailAccountId: account.id,
        threadingIds: [randomUUID()],
        subject: "Test",
        receivedAt: new Date("2026-01-01T00:00:00Z"),
      });
      const id = randomUUID();
      await db.insert(messages).values({
        id,
        mailAccountId: account.id,
        threadId,
        folderId: allMail.id,
        uid: 1,
        subject: "Test",
        fromName: "Bob",
        fromAddress: "bob@x.test",
        sentAt: new Date("2026-01-01T00:00:00Z"),
        receivedAt: new Date("2026-01-01T00:00:00Z"),
        gmailLabels,
      });
      return id;
    }

    it("records a new_mail entry for a \\Inbox-labelled All Mail message", async () => {
      const allMail = await seedFolder("all", "[Gmail]/All Mail");
      const messageId = await seedGmailMessage(allMail, ["\\Inbox"]);

      await recordNewMailNotifications(db, allMail, account, [messageId]);

      expect((await listUndelivered(db)).map((row) => row.kind)).toEqual(["new_mail"]);
    });

    it("never records anything for an unlabelled All Mail message — it's archived, not the Inbox", async () => {
      const allMail = await seedFolder("all", "[Gmail]/All Mail");
      const messageId = await seedGmailMessage(allMail, null);

      await recordNewMailNotifications(db, allMail, account, [messageId]);

      expect(await listUndelivered(db)).toEqual([]);
    });
  });
});

describe("recordNeedsReauthNotification", () => {
  it("records a needs_reauth entry keyed on the account and its transition instant", async () => {
    await recordNeedsReauthNotification(db, account);
    const [entry] = await listUndelivered(db);
    expect(entry?.kind).toBe("needs_reauth");
    expect(entry?.dedupKey).toBe(`${account.id}:${account.updatedAt.toISOString()}`);
    expect(entry?.payload).toEqual({ kind: "needs_reauth", emailAddress: account.emailAddress });
  });
});

describe("recordFailedSendNotification", () => {
  it("records a failed_send entry keyed on the Composition id", async () => {
    await recordFailedSendNotification(
      db,
      account,
      { id: "composition-1", subject: "Re: hi" },
      "550 rejected",
    );
    const [entry] = await listUndelivered(db);
    expect(entry?.kind).toBe("failed_send");
    expect(entry?.dedupKey).toBe("composition-1");
    expect(entry?.payload).toEqual({
      kind: "failed_send",
      compositionId: "composition-1",
      subject: "Re: hi",
      detail: "550 rejected",
    });
  });
});
