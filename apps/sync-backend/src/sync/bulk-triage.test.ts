import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, messages, protocolWrites, threads } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  applyBulkTriageAction,
  countTargetThreads,
  selectTargetThreadIds,
  undoBulkTriageAction,
} from "./bulk-triage.js";
import { resolveThread } from "./threading.js";

/**
 * `sync/bulk-triage.ts` against a real Postgres — the target-set query and
 * the batched mutations are statements, not pure functions, and `routes/
 * bulk-triage.test.ts` covers the HTTP-level acceptance bar (per-account
 * outcome, idempotency, Undo). This file is the query/mutation mechanics
 * underneath it: date-bound edges, folder-role handling, and the exact
 * reversal Undo performs.
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
  folderIdsByAccountAndRole.clear();
  uidsByFolder.clear();
});

afterAll(async () => {
  await closeDb?.();
});

async function seedFolder(
  mailAccountId: string,
  role: "inbox" | "archive" | "trash" | "sent",
  path: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(folders).values({ id, mailAccountId, path, name: path, role });
  return id;
}

const folderIdsByAccountAndRole = new Map<string, string>();
const uidsByFolder = new Map<string, number>();

/** `(folderId, uid)` is unique — a shared per-role folder needs a fresh uid per Message. */
function nextUid(folderId: string): number {
  const uid = (uidsByFolder.get(folderId) ?? 0) + 1;
  uidsByFolder.set(folderId, uid);
  return uid;
}

/** Memoized per (mailAccountId, role) within a test — real folder identity, never re-created. */
async function folderForRole(
  mailAccountId: string,
  role: "inbox" | "archive" | "trash" | "sent",
): Promise<string> {
  const key = `${mailAccountId}:${role}`;
  const existing = folderIdsByAccountAndRole.get(key);
  if (existing) return existing;
  const id = await seedFolder(mailAccountId, role, role.toUpperCase());
  folderIdsByAccountAndRole.set(key, id);
  return id;
}

/** One Thread with one Message at a given `lastMessageAt`, in a folder of the given role. Inbox by default. */
async function seedThread(
  lastMessageAt: Date,
  overrides: {
    mailAccountId?: string;
    folderRole?: "inbox" | "archive" | "trash" | "sent";
    inInbox?: boolean;
  } = {},
): Promise<string> {
  const mailAccountId = overrides.mailAccountId ?? account.id;
  const threadId = await resolveThread(db, {
    mailAccountId,
    threadingIds: [randomUUID()],
    subject: "Test",
    receivedAt: lastMessageAt,
  });
  const role = overrides.folderRole ?? "inbox";
  // One real folder per role per Mail Account, reused across calls within a
  // test — `folders`' unique `(mailAccountId, path)` index rejects a second
  // "INBOX" the way a real account only ever has one.
  const folderId = await folderForRole(mailAccountId, role);
  await db.insert(messages).values({
    id: randomUUID(),
    mailAccountId,
    threadId,
    folderId,
    uid: nextUid(folderId),
    subject: "Test",
    sentAt: lastMessageAt,
    receivedAt: lastMessageAt,
    seen: false,
  });
  if (overrides.inInbox === false) {
    await db.update(threads).set({ inInbox: false }).where(eq(threads.id, threadId));
  }
  return threadId;
}

async function threadRow(threadId: string) {
  const [row] = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
  return row;
}

const JAN_1 = new Date("2026-01-01T00:00:00Z");
const JAN_2 = new Date("2026-01-02T00:00:00Z");
const JAN_3 = new Date("2026-01-03T00:00:00Z");

describe("selectTargetThreadIds", () => {
  it("bounds by lastMessageAt: since is inclusive, until is exclusive", async () => {
    const before = await seedThread(new Date("2025-12-31T23:59:59Z"));
    const atSince = await seedThread(JAN_1);
    const middle = await seedThread(JAN_2);
    const atUntil = await seedThread(JAN_3);

    const ids = await selectTargetThreadIds(db, {
      mailAccountId: account.id,
      folderRole: "inbox",
      since: JAN_1,
      until: JAN_3,
    });

    expect(ids.sort()).toEqual([atSince, middle].sort());
    expect(ids).not.toContain(before);
    expect(ids).not.toContain(atUntil);
  });

  it("since: null reaches every Thread down to the beginning", async () => {
    const old = await seedThread(new Date("2020-01-01T00:00:00Z"));
    const recent = await seedThread(JAN_1);

    const ids = await selectTargetThreadIds(db, {
      mailAccountId: account.id,
      folderRole: "inbox",
      since: null,
      until: JAN_2,
    });

    expect(ids.sort()).toEqual([old, recent].sort());
  });

  it('folderRole "inbox" reads threads.inInbox, not folder membership', async () => {
    const inInbox = await seedThread(JAN_1);
    const archived = await seedThread(JAN_1, { inInbox: false });

    const ids = await selectTargetThreadIds(db, {
      mailAccountId: account.id,
      folderRole: "inbox",
      since: null,
      until: JAN_2,
    });

    expect(ids).toEqual([inInbox]);
    expect(ids).not.toContain(archived);
  });

  it("a non-inbox folderRole matches Threads with a Message in that folder role", async () => {
    const sent = await seedThread(JAN_1, { folderRole: "sent" });
    const inbox = await seedThread(JAN_1, { folderRole: "inbox" });

    const ids = await selectTargetThreadIds(db, {
      mailAccountId: account.id,
      folderRole: "sent",
      since: null,
      until: JAN_2,
    });

    expect(ids).toEqual([sent]);
    expect(ids).not.toContain(inbox);
  });

  it("never crosses Mail Accounts", async () => {
    const other = await createTestMailAccount(db);
    await seedThread(JAN_1);
    const otherThread = await seedThread(JAN_1, { mailAccountId: other.id });

    const ids = await selectTargetThreadIds(db, {
      mailAccountId: other.id,
      folderRole: "inbox",
      since: null,
      until: JAN_2,
    });

    expect(ids).toEqual([otherThread]);
  });
});

describe("countTargetThreads", () => {
  it("matches the length of selectTargetThreadIds for the same target", async () => {
    await seedThread(JAN_1);
    await seedThread(JAN_1);
    await seedThread(new Date("2025-01-01T00:00:00Z")); // out of range

    const target = {
      mailAccountId: account.id,
      folderRole: "inbox" as const,
      since: JAN_1,
      until: JAN_2,
    };
    expect(await countTargetThreads(db, target)).toBe(
      (await selectTargetThreadIds(db, target)).length,
    );
    expect(await countTargetThreads(db, target)).toBe(2);
  });
});

describe("applyBulkTriageAction", () => {
  it('"done" flips inInbox and queues an archive protocol write for Inbox-resident Messages', async () => {
    const threadId = await seedThread(JAN_1);

    await applyBulkTriageAction(db, account.id, "done", [threadId]);

    expect((await threadRow(threadId))?.inInbox).toBe(false);
    const outbox = await db
      .select()
      .from(protocolWrites)
      .where(eq(protocolWrites.mailAccountId, account.id));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ kind: "archive" });
  });

  it('"markRead" marks every Message seen and refreshes the Thread rollup', async () => {
    const threadId = await seedThread(JAN_1);

    await applyBulkTriageAction(db, account.id, "markRead", [threadId]);

    const [message] = await db.select().from(messages).where(eq(messages.threadId, threadId));
    expect(message?.seen).toBe(true);
    expect((await threadRow(threadId))?.unreadCount).toBe(0);
    const outbox = await db
      .select()
      .from(protocolWrites)
      .where(eq(protocolWrites.mailAccountId, account.id));
    expect(outbox.map((row) => row.kind)).toEqual(["seen"]);
  });

  it("is a no-op on an empty thread-id list", async () => {
    await applyBulkTriageAction(db, account.id, "done", []);
    const outbox = await db.select().from(protocolWrites);
    expect(outbox).toHaveLength(0);
  });
});

describe("undoBulkTriageAction", () => {
  it('undoes "done" by setting inInbox back to true and cancelling the queued archive move', async () => {
    const threadId = await seedThread(JAN_1);
    await applyBulkTriageAction(db, account.id, "done", [threadId]);
    expect((await threadRow(threadId))?.inInbox).toBe(false);

    await undoBulkTriageAction(db, "done", [threadId]);

    expect((await threadRow(threadId))?.inInbox).toBe(true);
    const outbox = await db
      .select()
      .from(protocolWrites)
      .where(eq(protocolWrites.mailAccountId, account.id));
    expect(outbox).toHaveLength(0);
  });

  it('undoes "markRead" by setting every Message back to unseen and cancelling the queued seen write', async () => {
    const threadId = await seedThread(JAN_1);
    await applyBulkTriageAction(db, account.id, "markRead", [threadId]);

    await undoBulkTriageAction(db, "markRead", [threadId]);

    const [message] = await db.select().from(messages).where(eq(messages.threadId, threadId));
    expect(message?.seen).toBe(false);
    expect((await threadRow(threadId))?.unreadCount).toBe(1);
    const outbox = await db
      .select()
      .from(protocolWrites)
      .where(eq(protocolWrites.mailAccountId, account.id));
    expect(outbox).toHaveLength(0);
  });

  it("touches only the recorded Thread ids, never the rest of the original target set", async () => {
    const undone = await seedThread(JAN_1);
    const untouched = await seedThread(JAN_1);
    await applyBulkTriageAction(db, account.id, "done", [undone, untouched]);

    // Only `undone` was recorded as affected — the same distinction
    // `routes/bulk-triage.ts` draws between the target set and the batch's
    // own `affectedThreadIds` ledger column.
    await undoBulkTriageAction(db, "done", [undone]);

    expect((await threadRow(undone))?.inInbox).toBe(true);
    expect((await threadRow(untouched))?.inInbox).toBe(false);
  });
});
