import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, messages, protocolWrites, threads } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { drainProtocolWrites, enqueueProtocolWrites } from "./protocol-writes.js";
import { resolveThread } from "./threading.js";

/**
 * The server-kind gate (#124, ADR-0020) against a fake `ImapFlow` rather
 * than GreenMail: GreenMail advertises no `X-GM-EXT-1` (`server-kind.ts`'s
 * own doc comment), so nothing in this repo's dev infra can prove a Gmail
 * account's `archive`/`inbox` rows become a label `STORE` rather than a
 * `MOVE` — or, just as importantly, that a generic account's rows never
 * reach a label call at all. `protocol-writes.greenmail.test.ts` still owns
 * the real-`MOVE`/real-`STORE` acceptance bar this file's fake client can't.
 */

let db: Db;
let closeDb: () => Promise<void>;

interface RecordedCall {
  method: "messageFlagsAdd" | "messageFlagsRemove" | "messageMove";
  uids: number[];
  target: string | string[];
  useLabels?: boolean;
}

function createFakeClient(): { client: ImapFlow; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fake = {
    async getMailboxLock(path: string) {
      return { path, release() {} };
    },
    async messageFlagsAdd(uids: number[], flags: string[], options?: { useLabels?: boolean }) {
      calls.push({
        method: "messageFlagsAdd",
        uids,
        target: flags,
        useLabels: options?.useLabels,
      });
      return true;
    },
    async messageFlagsRemove(uids: number[], flags: string[], options?: { useLabels?: boolean }) {
      calls.push({
        method: "messageFlagsRemove",
        uids,
        target: flags,
        useLabels: options?.useLabels,
      });
      return true;
    },
    async messageMove(uids: number[], destination: string | string[]) {
      calls.push({ method: "messageMove", uids, target: destination });
      return {
        path: "source",
        destination: Array.isArray(destination) ? (destination[0] ?? "") : destination,
        uidMap: new Map(uids.map((uid) => [uid, uid])),
      };
    },
  };
  return { client: fake as unknown as ImapFlow, calls };
}

async function seedFolder(
  mailAccountId: string,
  role: "inbox" | "archive" | "trash" | "junk" | "all",
  path: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(folders).values({ id, mailAccountId, path, name: path, role });
  return id;
}

async function seedMessage(
  account: MailAccountRow,
  folderId: string,
  uid: number,
  gmailLabels: string[] | null = null,
): Promise<{ threadId: string; messageId: string }> {
  const threadId = await resolveThread(db, {
    mailAccountId: account.id,
    threadingIds: [randomUUID()],
    subject: "Test",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
  });
  const messageId = randomUUID();
  await db.insert(messages).values({
    id: messageId,
    mailAccountId: account.id,
    threadId,
    folderId,
    uid,
    subject: "Test",
    sentAt: new Date("2026-01-01T00:00:00Z"),
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    gmailLabels,
  });
  return { threadId, messageId };
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

describe("drainProtocolWrites — the server-kind gate (#124, ADR-0020)", () => {
  it("issues a \\Inbox label removal, never a MOVE, for an archive row on a Gmail account", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    const allMailId = await seedFolder(account.id, "all", "[Gmail]/All Mail");
    const { messageId } = await seedMessage(account, allMailId, 5, ["\\Inbox"]);
    await enqueueProtocolWrites(db, account.id, [messageId], "archive");

    const { client, calls } = createFakeClient();
    const applied = await drainProtocolWrites(db, client, account.id);

    expect(applied).toBe(1);
    expect(calls).toEqual([
      { method: "messageFlagsRemove", uids: [5], target: ["\\Inbox"], useLabels: true },
    ]);
    const [message] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(message?.gmailLabels).toEqual([]);
    expect(
      await db.select().from(protocolWrites).where(eq(protocolWrites.mailAccountId, account.id)),
    ).toHaveLength(0);
  });

  it("issues a real MOVE, never a label call, for an archive row on a generic account", async () => {
    const account = await createTestMailAccount(db, { serverKind: "generic" });
    const inboxId = await seedFolder(account.id, "inbox", "INBOX");
    await seedFolder(account.id, "archive", "Archive");
    const { messageId } = await seedMessage(account, inboxId, 5);
    await enqueueProtocolWrites(db, account.id, [messageId], "archive");

    const { client, calls } = createFakeClient();
    const applied = await drainProtocolWrites(db, client, account.id);

    expect(applied).toBe(1);
    expect(calls).toEqual([{ method: "messageMove", uids: [5], target: "Archive" }]);
    expect(calls.some((call) => call.useLabels)).toBe(false);
  });

  it("issues a \\Inbox label add, never a MOVE, restoring a Gmail Done archive still in All Mail", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    const allMailId = await seedFolder(account.id, "all", "[Gmail]/All Mail");
    const { threadId, messageId } = await seedMessage(account, allMailId, 9, null);
    await db
      .update(threads)
      .set({ inInbox: false, folderRole: "archive" })
      .where(eq(threads.id, threadId));
    await enqueueProtocolWrites(db, account.id, [messageId], "inbox");

    const { client, calls } = createFakeClient();
    const applied = await drainProtocolWrites(db, client, account.id);

    expect(applied).toBe(1);
    expect(calls).toEqual([
      { method: "messageFlagsAdd", uids: [9], target: ["\\Inbox"], useLabels: true },
    ]);
    const [message] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(message?.gmailLabels).toEqual(["\\Inbox"]);
  });

  it("issues a real MOVE back to All Mail, not a label call, restoring a Gmail account's Trash-resident Message", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    await seedFolder(account.id, "all", "[Gmail]/All Mail");
    const trashId = await seedFolder(account.id, "trash", "[Gmail]/Trash");
    const { messageId } = await seedMessage(account, trashId, 3, ["\\Inbox"]);
    await enqueueProtocolWrites(db, account.id, [messageId], "inbox");

    const { client, calls } = createFakeClient();
    const applied = await drainProtocolWrites(db, client, account.id);

    expect(applied).toBe(1);
    expect(calls).toEqual([{ method: "messageMove", uids: [3], target: "[Gmail]/All Mail" }]);
  });

  it("issues a real MOVE to the Trash Folder, never a label call, trashing a Gmail account's All Mail Message", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    const allMailId = await seedFolder(account.id, "all", "[Gmail]/All Mail");
    await seedFolder(account.id, "trash", "[Gmail]/Trash");
    const { messageId } = await seedMessage(account, allMailId, 7, ["\\Inbox"]);
    await enqueueProtocolWrites(db, account.id, [messageId], "trash");

    const { client, calls } = createFakeClient();
    const applied = await drainProtocolWrites(db, client, account.id);

    expect(applied).toBe(1);
    expect(calls).toEqual([{ method: "messageMove", uids: [7], target: "[Gmail]/Trash" }]);
    expect(calls.some((call) => call.useLabels)).toBe(false);
  });
});
