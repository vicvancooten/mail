import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, messages, threadMessageIds, threads } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { threadingIdsFor } from "./message-ids.js";
import { refreshThreadRollups } from "./thread-rollup.js";
import { deleteEmptyThreads, resolveThread } from "./threading.js";

/**
 * Threading against a real Postgres, because the interesting half of it is
 * the merge — a statement, not a pure function. The scenarios here are the
 * ones ADR-0005's **newest-first** backfill actually produces: replies land
 * before the messages they answer, and two chains turn out to be one.
 */
let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let folderId: string;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db);
  folderId = randomUUID();
  await db.insert(folders).values({
    id: folderId,
    mailAccountId: account.id,
    path: "INBOX",
    name: "INBOX",
    role: "inbox",
  });
});

afterAll(async () => {
  await closeDb?.();
});

let nextUid = 1;

/** Stores one message the way `ingest.ts` does, minus the IMAP round trip. */
async function store(input: {
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  subject: string;
  receivedAt: Date;
  seen?: boolean;
  flagged?: boolean;
  snippet?: string;
}): Promise<{ id: string; threadId: string }> {
  const threadId = await resolveThread(db, {
    mailAccountId: account.id,
    threadingIds: threadingIdsFor({
      messageId: input.messageId,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? [],
    }),
    subject: input.subject,
    receivedAt: input.receivedAt,
  });

  const id = randomUUID();
  await db.insert(messages).values({
    id,
    mailAccountId: account.id,
    threadId,
    folderId,
    uid: nextUid++,
    messageIdHeader: input.messageId,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? [],
    subject: input.subject,
    fromName: "Alice",
    fromAddress: "alice@example.test",
    sentAt: input.receivedAt,
    receivedAt: input.receivedAt,
    seen: input.seen ?? false,
    flagged: input.flagged ?? false,
    snippet: input.snippet ?? null,
  });

  await refreshThreadRollups(db, [threadId]);
  return { id, threadId };
}

function at(day: number): Date {
  return new Date(Date.UTC(2025, 2, day, 9, 0, 0));
}

describe("resolveThread", () => {
  it("puts a reply stored before its parent in the same Thread as the parent", async () => {
    // The order a newest-first backfill produces: the reply first.
    const reply = await store({
      messageId: "b@example.test",
      inReplyTo: "a@example.test",
      references: ["a@example.test"],
      subject: "Re: Tuesday",
      receivedAt: at(4),
    });
    const parent = await store({
      messageId: "a@example.test",
      subject: "Tuesday",
      receivedAt: at(3),
    });

    expect(parent.threadId).toBe(reply.threadId);

    const [thread] = await db.select().from(threads).where(eq(threads.id, reply.threadId));
    // The Thread is labelled by the conversation's opening subject, not the reply's.
    expect(thread?.subject).toBe("Tuesday");
    expect(thread?.messageCount).toBe(2);
  });

  it("keeps unrelated conversations apart even when they share a subject", async () => {
    const one = await store({ messageId: "x@a.test", subject: "Invoice", receivedAt: at(3) });
    const two = await store({ messageId: "y@b.test", subject: "Invoice", receivedAt: at(4) });

    expect(one.threadId).not.toBe(two.threadId);
  });

  it("merges two Threads when a late message bridges their chains", async () => {
    const left = await store({ messageId: "a@example.test", subject: "Plan", receivedAt: at(1) });
    const right = await store({ messageId: "c@example.test", subject: "Plan", receivedAt: at(5) });
    expect(left.threadId).not.toBe(right.threadId);

    const bridge = await store({
      messageId: "b@example.test",
      inReplyTo: "a@example.test",
      references: ["a@example.test", "c@example.test"],
      subject: "Re: Plan",
      receivedAt: at(3),
    });

    // The oldest Thread survives, so a Client that already cached it keeps
    // pointing at the right conversation.
    expect(bridge.threadId).toBe(left.threadId);

    const remaining = await db.select().from(threads).where(eq(threads.mailAccountId, account.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.messageCount).toBe(3);

    const registered = await db
      .select()
      .from(threadMessageIds)
      .where(eq(threadMessageIds.threadId, left.threadId));
    expect(registered.map((row) => row.messageIdHeader).sort()).toEqual([
      "a@example.test",
      "b@example.test",
      "c@example.test",
    ]);
  });

  it("gives a message with no usable ids a Thread of its own", async () => {
    const first = await resolveThread(db, {
      mailAccountId: account.id,
      threadingIds: [],
      subject: "No id",
      receivedAt: at(2),
    });
    const second = await resolveThread(db, {
      mailAccountId: account.id,
      threadingIds: [],
      subject: "No id",
      receivedAt: at(2),
    });

    expect(first).not.toBe(second);
  });
});

describe("refreshThreadRollups", () => {
  it("summarizes the Thread from its messages", async () => {
    const opening = await store({
      messageId: "a@example.test",
      subject: "Numbers",
      receivedAt: at(1),
      seen: true,
      snippet: "first",
    });
    await store({
      messageId: "b@example.test",
      references: ["a@example.test"],
      subject: "Re: Numbers",
      receivedAt: at(2),
      flagged: true,
      snippet: "latest",
    });

    const [thread] = await db.select().from(threads).where(eq(threads.id, opening.threadId));

    expect(thread).toMatchObject({
      subject: "Numbers",
      messageCount: 2,
      unreadCount: 1,
      starred: true,
      snippet: "latest",
      hasAttachments: false,
    });
    expect(thread?.lastMessageAt?.toISOString()).toBe(at(2).toISOString());
    expect(thread?.participants).toEqual([{ name: "Alice", address: "alice@example.test" }]);
  });
});

describe("deleteEmptyThreads", () => {
  it("removes a Thread once its last message is gone", async () => {
    const { id, threadId } = await store({
      messageId: "a@example.test",
      subject: "Gone",
      receivedAt: at(1),
    });

    await db.delete(messages).where(eq(messages.id, id));
    expect(await deleteEmptyThreads(db, account.id)).toBe(1);

    const remaining = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(remaining).toHaveLength(0);
  });
});
