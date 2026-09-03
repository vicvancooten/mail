import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, labels, messageSearch, messages, threads } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { reindexMessages } from "./search-index.js";
import { CANDIDATE_WINDOW, PAGE_SIZE, runSearch } from "./search-query.js";

/**
 * `POST /search`'s ranking/filtering core (#50, ADR-0016) against a real
 * Postgres — the Candidate Window, `tsquery` matching and `ts_headline` only
 * exist at the database boundary. `routes/search.test.ts` covers the HTTP
 * layer (auth, ownership, wire assembly) on top of this.
 */

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;
let inboxId: string;
let trashId: string;

let uidCounter = 0;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db);
  uidCounter = 0;

  inboxId = randomUUID();
  trashId = randomUUID();
  await db.insert(folders).values([
    { id: inboxId, mailAccountId: account.id, path: "INBOX", name: "INBOX", role: "inbox" },
    { id: trashId, mailAccountId: account.id, path: "Trash", name: "Trash", role: "trash" },
  ]);
});

afterAll(async () => {
  await closeDb?.();
});

interface SeedInput {
  /** Defaults to the shared `account` — an Account Scope (#68) test overrides it to seed a second account. */
  mailAccountId?: string;
  folderId?: string;
  subject?: string;
  fromName?: string | null;
  fromAddress?: string | null;
  toAddresses?: { name: string | null; address: string }[];
  ccAddresses?: { name: string | null; address: string }[];
  sentAt?: Date;
  bodyText?: string | null;
  hasAttachments?: boolean;
  labelIds?: string[];
}

/** Seeds one Thread with one Message and writes its Search Index row. */
async function seedMessage(
  input: SeedInput = {},
): Promise<{ threadId: string; messageId: string }> {
  const threadId = randomUUID();
  const messageId = randomUUID();
  const mailAccountId = input.mailAccountId ?? account.id;
  uidCounter += 1;

  await db.insert(threads).values({
    id: threadId,
    mailAccountId,
    labelIds: input.labelIds ?? [],
  });
  await db.insert(messages).values({
    id: messageId,
    mailAccountId,
    threadId,
    folderId: input.folderId ?? inboxId,
    uid: uidCounter,
    subject: input.subject ?? "Quarterly budget",
    fromName: input.fromName ?? "Vic van Cooten",
    fromAddress: input.fromAddress ?? "vic.van.cooten@a-insights.eu",
    toAddresses: input.toAddresses ?? [],
    ccAddresses: input.ccAddresses ?? [],
    sentAt: input.sentAt ?? new Date("2024-06-15T12:00:00Z"),
    receivedAt: input.sentAt ?? new Date("2024-06-15T12:00:00Z"),
    bodyText: input.bodyText ?? null,
    hasAttachments: input.hasAttachments ?? false,
  });
  await reindexMessages(db, [messageId]);
  return { threadId, messageId };
}

describe("runSearch — free text", () => {
  it("finds mail by an address's local part and domain label (the load-bearing weight)", async () => {
    const { threadId } = await seedMessage({
      fromAddress: "kowalski0@a-insights.eu",
      subject: "no relevant words here",
    });

    const byLocalPart = await runSearch(db, { mailAccountIds: [account.id], text: "kowalski0" });
    expect(byLocalPart.rows.map((r) => r.threadId)).toEqual([threadId]);

    const byDomainLabel = await runSearch(db, { mailAccountIds: [account.id], text: "insights" });
    expect(byDomainLabel.rows.map((r) => r.threadId)).toEqual([threadId]);
  });

  it("supports type-ahead prefix matching on the trailing token (≥3 chars)", async () => {
    const { threadId } = await seedMessage({ subject: "Quarterly roadmap" });
    const result = await runSearch(db, { mailAccountIds: [account.id], text: "quarte" });
    expect(result.rows.map((r) => r.threadId)).toEqual([threadId]);
  });

  it("headlines a body match, but leaves a subject-only match's headline null", async () => {
    const { messageId: bodyMatchId } = await seedMessage({
      subject: "unrelated",
      bodyText: "the quarterly numbers are in this paragraph",
    });
    const { messageId: subjectMatchId } = await seedMessage({
      subject: "Quarterly numbers",
      bodyText: "nothing relevant in the body",
    });

    const result = await runSearch(db, { mailAccountIds: [account.id], text: "quarterly" });
    const byMessage = new Map(result.rows.map((row) => [row.matchedMessageId, row.headline]));
    expect(byMessage.get(bodyMatchId)).toContain("quarterly");
    expect(byMessage.get(subjectMatchId)).toBeNull();
  });

  it("returns nothing below its own default scope when there is no match at all", async () => {
    await seedMessage({ subject: "hello" });
    const result = await runSearch(db, { mailAccountIds: [account.id], text: "nomatch" });
    expect(result).toEqual({ rows: [], cursor: null });
  });
});

describe("runSearch — structured filters", () => {
  it("from: matches display name or address", async () => {
    const { threadId } = await seedMessage({
      fromName: "Ann Chen",
      fromAddress: "ann@example.com",
    });
    await seedMessage({ fromName: "Bo Beckett", fromAddress: "bo@example.com" });

    const byName = await runSearch(db, { mailAccountIds: [account.id], text: "", from: "Chen" });
    expect(byName.rows.map((r) => r.threadId)).toEqual([threadId]);

    const byAddress = await runSearch(db, { mailAccountIds: [account.id], text: "", from: "ann@" });
    expect(byAddress.rows.map((r) => r.threadId)).toEqual([threadId]);
  });

  it("to: includes Cc", async () => {
    const { threadId } = await seedMessage({
      ccAddresses: [{ name: "Hidden Cc", address: "cc@example.com" }],
    });
    const result = await runSearch(db, { mailAccountIds: [account.id], text: "", to: "Hidden Cc" });
    expect(result.rows.map((r) => r.threadId)).toEqual([threadId]);
  });

  it("has:attachment", async () => {
    const { threadId } = await seedMessage({ hasAttachments: true });
    await seedMessage({ hasAttachments: false });
    const result = await runSearch(db, {
      mailAccountIds: [account.id],
      text: "",
      hasAttachment: true,
    });
    expect(result.rows.map((r) => r.threadId)).toEqual([threadId]);
  });

  it("label: matches case-insensitively and is filtered off the Thread's own label_ids, not the Search Index", async () => {
    const labelId = randomUUID();
    await db.insert(labels).values({ id: labelId, mailAccountId: account.id, name: "Invoices" });
    const { threadId } = await seedMessage({ labelIds: [labelId] });
    await seedMessage({});

    const result = await runSearch(db, {
      mailAccountIds: [account.id],
      text: "",
      label: "INVOICES",
    });
    expect(result.rows.map((r) => r.threadId)).toEqual([threadId]);
  });

  it("label: naming nothing this account has returns empty, not an error", async () => {
    await seedMessage({});
    const result = await runSearch(db, {
      mailAccountIds: [account.id],
      text: "",
      label: "no-such-label",
    });
    expect(result).toEqual({ rows: [], cursor: null });
  });

  it("after:/before: bound sentAt", async () => {
    const { threadId } = await seedMessage({ sentAt: new Date("2024-06-15T00:00:00Z") });

    const inRange = await runSearch(db, {
      mailAccountIds: [account.id],
      text: "",
      after: "2024-01-01",
    });
    expect(inRange.rows.map((r) => r.threadId)).toEqual([threadId]);

    const outOfRange = await runSearch(db, {
      mailAccountIds: [account.id],
      text: "",
      before: "2024-01-01",
    });
    expect(outOfRange.rows).toEqual([]);
  });

  it("before: is inclusive of the named calendar day", async () => {
    const { threadId: onDay } = await seedMessage({ sentAt: new Date("2024-06-15T23:59:00Z") });
    const { threadId: nextDay } = await seedMessage({ sentAt: new Date("2024-06-16T00:01:00Z") });

    const result = await runSearch(db, {
      mailAccountIds: [account.id],
      text: "",
      before: "2024-06-15",
    });

    const matchedThreadIds = result.rows.map((r) => r.threadId);
    expect(matchedThreadIds).toContain(onDay);
    expect(matchedThreadIds).not.toContain(nextDay);
  });
});

describe("runSearch — folder scope (ADR-0016 default: every folder but Trash/Junk)", () => {
  it("excludes Trash by default, and in:trash is the escape that finds it", async () => {
    const { threadId } = await seedMessage({ folderId: trashId });

    const defaultScope = await runSearch(db, { mailAccountIds: [account.id], text: "" });
    expect(defaultScope.rows).toEqual([]);

    const trashScope = await runSearch(db, {
      mailAccountIds: [account.id],
      text: "",
      folder: "trash",
    });
    expect(trashScope.rows.map((r) => r.threadId)).toEqual([threadId]);
  });

  it("in: also matches a custom folder by name", async () => {
    const customId = randomUUID();
    await db
      .insert(folders)
      .values({ id: customId, mailAccountId: account.id, path: "Projects", name: "Projects" });
    const { threadId } = await seedMessage({ folderId: customId });

    const result = await runSearch(db, {
      mailAccountIds: [account.id],
      text: "",
      folder: "projects",
    });
    expect(result.rows.map((r) => r.threadId)).toEqual([threadId]);
  });

  it("in: naming a folder this account doesn't have returns empty, not an error", async () => {
    await seedMessage({});
    const result = await runSearch(db, {
      mailAccountIds: [account.id],
      text: "",
      folder: "archive",
    });
    expect(result.rows).toEqual([]);
  });
});

describe("runSearch — the Candidate Window and pagination", () => {
  it("pages the window back via cursor once matches exceed it, keyset on sentAt", async () => {
    const total = CANDIDATE_WINDOW + 1;
    const base = Date.parse("2020-01-01T00:00:00.000Z");
    const items = Array.from({ length: total }, (_, i) => ({
      threadId: randomUUID(),
      messageId: randomUUID(),
      uid: i + 1,
      sentAt: new Date(base + i * 1000),
    }));

    await db
      .insert(threads)
      .values(items.map((item) => ({ id: item.threadId, mailAccountId: account.id })));
    await db.insert(messages).values(
      items.map((item) => ({
        id: item.messageId,
        mailAccountId: account.id,
        threadId: item.threadId,
        folderId: inboxId,
        uid: item.uid,
        subject: "",
        sentAt: item.sentAt,
        receivedAt: item.sentAt,
      })),
    );
    await reindexMessages(
      db,
      items.map((item) => item.messageId),
    );

    const page1 = await runSearch(db, { mailAccountIds: [account.id], text: "" });
    expect(page1.rows).toHaveLength(PAGE_SIZE);
    expect(page1.cursor).not.toBeNull();
    // The window is recency-ranked — page 1 is the newest PAGE_SIZE threads.
    const newestThreadIds = new Set<string>(items.slice(-PAGE_SIZE).map((item) => item.threadId));
    for (const row of page1.rows) expect(newestThreadIds.has(row.threadId)).toBe(true);

    const page2 = await runSearch(db, {
      mailAccountIds: [account.id],
      text: "",
      cursor: page1.cursor as string,
    });
    // Exactly one message (the oldest of the 501) sits strictly older than
    // the first window's boundary.
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0]?.threadId).toBe(items[0]?.threadId);
    expect(page2.cursor).toBeNull();
  });
});

describe("runSearch — Thread merges keep the Search Index in step", () => {
  it("moves a merged Thread's search row to the survivor id (sync/threading.ts#mergeThreads)", async () => {
    // Regression guard at the query level: `sync/threading.test.ts` proves
    // the merge itself; this proves a stale `thread_id` in `message_search`
    // would otherwise surface as a search result pointing at a deleted Thread.
    const { threadId, messageId } = await seedMessage({ subject: "Quarterly roadmap" });
    const survivorId = randomUUID();
    await db.insert(threads).values({ id: survivorId, mailAccountId: account.id });
    await db.update(messages).set({ threadId: survivorId }).where(eq(messages.id, messageId));
    await db
      .update(messageSearch)
      .set({ threadId: survivorId })
      .where(eq(messageSearch.threadId, threadId));

    const result = await runSearch(db, { mailAccountIds: [account.id], text: "quarterly" });
    expect(result.rows.map((r) => r.threadId)).toEqual([survivorId]);
  });
});

describe("runSearch — Account Scope (#68, ADR-0016 amendment)", () => {
  let account2: MailAccountRow;
  let inbox2Id: string;

  beforeEach(async () => {
    // Same User as `account` — an Account Scope is always the requesting
    // User's own accounts (`routes/search.ts` enforces ownership; this file
    // only exercises the ranking core).
    account2 = await createTestMailAccount(db, { userId: account.userId });
    inbox2Id = randomUUID();
    await db.insert(folders).values({
      id: inbox2Id,
      mailAccountId: account2.id,
      path: "INBOX",
      name: "INBOX",
      role: "inbox",
    });
  });

  it("merges and re-ranks matches from every in-scope account", async () => {
    const { threadId: fromFirst } = await seedMessage({ subject: "Quarterly roadmap" });
    const { threadId: fromSecond } = await seedMessage({
      mailAccountId: account2.id,
      folderId: inbox2Id,
      subject: "Quarterly numbers",
    });

    const result = await runSearch(db, {
      mailAccountIds: [account.id, account2.id],
      text: "quarterly",
    });
    expect(new Set(result.rows.map((r) => r.threadId))).toEqual(new Set([fromFirst, fromSecond]));
  });

  it("gives each account its own Candidate Window — a chatty account cannot crowd a quiet one out of its own window", async () => {
    // The rejected design ADR-0016 amends against: one Candidate Window
    // shared across the Scope, filled by recency alone. If that were the
    // implementation, `account`'s CANDIDATE_WINDOW newer matches would fill
    // the entire shared window and `account2`'s one (much older) match would
    // never even be considered, regardless of how well it matches.
    const base = Date.parse("2024-06-15T00:00:00.000Z");
    const chattyItems = Array.from({ length: CANDIDATE_WINDOW }, (_, i) => ({
      threadId: randomUUID(),
      messageId: randomUUID(),
      uid: i + 1,
      sentAt: new Date(base - i * 1000),
    }));
    await db
      .insert(threads)
      .values(chattyItems.map((item) => ({ id: item.threadId, mailAccountId: account.id })));
    await db.insert(messages).values(
      chattyItems.map((item) => ({
        id: item.messageId,
        mailAccountId: account.id,
        threadId: item.threadId,
        folderId: inboxId,
        uid: item.uid,
        subject: "unrelated",
        bodyText: "evergreen",
        sentAt: item.sentAt,
        receivedAt: item.sentAt,
      })),
    );
    await reindexMessages(
      db,
      chattyItems.map((item) => item.messageId),
    );

    // Older than every chatty message (by far more than the ~500s the
    // chatty pool spans, so a shared window sorted by recency would never
    // reach it), but the *only* match `account2` has — and its subject
    // (weight A) beats the chatty pool's body-only match (weight D) on
    // `ts_rank_cd` by enough to swamp the tiny recency-decay difference, so
    // its presence in the final page is decided by window membership, not a
    // ranking coin flip.
    const { threadId: quietThreadId } = await seedMessage({
      mailAccountId: account2.id,
      folderId: inbox2Id,
      subject: "evergreen",
      bodyText: null,
      sentAt: new Date(base - 1_000_000_000),
    });

    const result = await runSearch(db, {
      mailAccountIds: [account.id, account2.id],
      text: "evergreen",
    });
    expect(result.rows.map((r) => r.threadId)).toContain(quietThreadId);
  });

  it("an in-scope account missing the named folder/label contributes nothing; others still do", async () => {
    const customId = randomUUID();
    await db
      .insert(folders)
      .values({ id: customId, mailAccountId: account.id, path: "Projects", name: "Projects" });
    const { threadId: inProjects } = await seedMessage({
      folderId: customId,
      subject: "Quarterly plan",
    });
    // account2 has no "Projects" folder at all.
    await seedMessage({
      mailAccountId: account2.id,
      folderId: inbox2Id,
      subject: "Quarterly numbers",
    });

    const result = await runSearch(db, {
      mailAccountIds: [account.id, account2.id],
      text: "quarterly",
      folder: "projects",
    });
    expect(result.rows.map((r) => r.threadId)).toEqual([inProjects]);
  });

  describe("pagination", () => {
    async function seedWindow(
      mailAccountId: string,
      folderId: string,
      count: number,
      base: number,
    ): Promise<{ threadId: string; messageId: string; sentAt: Date }[]> {
      const items = Array.from({ length: count }, (_, i) => ({
        threadId: randomUUID(),
        messageId: randomUUID(),
        uid: i + 1,
        sentAt: new Date(base + i * 1000),
      }));
      await db.insert(threads).values(items.map((item) => ({ id: item.threadId, mailAccountId })));
      await db.insert(messages).values(
        items.map((item) => ({
          id: item.messageId,
          mailAccountId,
          threadId: item.threadId,
          folderId,
          uid: item.uid,
          subject: "",
          sentAt: item.sentAt,
          receivedAt: item.sentAt,
        })),
      );
      await reindexMessages(
        db,
        items.map((item) => item.messageId),
      );
      return items;
    }

    it("keeps paging an account whose window is still full while dropping one that already exhausted", async () => {
      const base = Date.parse("2020-01-01T00:00:00.000Z");
      // account: exceeds its own window by one — still has more after page 1.
      const fullItems = await seedWindow(account.id, inboxId, CANDIDATE_WINDOW + 1, base);
      // account2: well under its own window, and newer than everything in
      // `account` — fully returned on page 1, deterministically at the top.
      const shortItems = await seedWindow(account2.id, inbox2Id, 3, base + 10_000_000);

      const page1 = await runSearch(db, { mailAccountIds: [account.id, account2.id], text: "" });
      expect(page1.cursor).not.toBeNull();
      const page1Ids = new Set(page1.rows.map((r) => r.threadId));
      for (const item of shortItems) expect(page1Ids.has(item.threadId)).toBe(true);

      const page2 = await runSearch(db, {
        mailAccountIds: [account.id, account2.id],
        text: "",
        cursor: page1.cursor as string,
      });
      // Only account's oldest (501st) message is left — account2 had
      // nothing more and is not re-queried, so it cannot resurface here.
      expect(page2.rows).toHaveLength(1);
      expect(page2.rows[0]?.threadId).toBe(fullItems[0]?.threadId);
      expect(page2.cursor).toBeNull();
    });

    it("picks up an account newly added to the Scope on a later page rather than treating it as exhausted", async () => {
      const base = Date.parse("2020-01-01T00:00:00.000Z");
      const fullItems = await seedWindow(account.id, inboxId, CANDIDATE_WINDOW + 1, base);

      const page1 = await runSearch(db, { mailAccountIds: [account.id], text: "" });
      expect(page1.cursor).not.toBeNull();

      // account2 didn't exist in the Scope page 1 was run over.
      const { threadId: newAccountThreadId } = await seedMessage({
        mailAccountId: account2.id,
        folderId: inbox2Id,
        subject: "hello",
        sentAt: new Date(base - 10_000_000),
      });

      const page2 = await runSearch(db, {
        mailAccountIds: [account.id, account2.id],
        text: "",
        cursor: page1.cursor as string,
      });
      const page2ThreadIds = page2.rows.map((r) => r.threadId);
      expect(page2ThreadIds).toContain(newAccountThreadId);
      expect(page2ThreadIds).toContain(fullItems[0]?.threadId);
    });
  });
});
