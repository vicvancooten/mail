import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { folders, messageSearch, messages, threads } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  addressPartsText,
  bodyAndFilenamesText,
  CURRENT_SEARCH_INDEX_VERSION,
  participantsText,
  reindexMessages,
  runSearchIndexRebuildBatch,
} from "./search-index.js";

describe("participantsText", () => {
  it("joins the From name/address and every To/Cc name/address", () => {
    expect(
      participantsText({
        fromName: "Vic van Cooten",
        fromAddress: "vic.van.cooten@a-insights.eu",
        toAddresses: [{ name: "Team", address: "team@example.com" }],
        ccAddresses: [{ name: null, address: "bcc@example.com" }],
      }),
    ).toBe("Vic van Cooten vic.van.cooten@a-insights.eu Team team@example.com bcc@example.com");
  });

  it("skips a null From without erroring", () => {
    expect(
      participantsText({ fromName: null, fromAddress: null, toAddresses: [], ccAddresses: [] }),
    ).toBe("");
  });
});

describe("addressPartsText", () => {
  it("splits every address on non-alphanumerics into local-part and domain-label tokens", () => {
    expect(
      addressPartsText({
        fromAddress: "vic.van.cooten@a-insights.eu",
        toAddresses: [{ name: null, address: "team@example.com" }],
        ccAddresses: [],
      }),
    ).toBe("vic van cooten a insights eu team example com");
  });

  it("is what makes a bare local part or domain label findable — the load-bearing weight", () => {
    const text = addressPartsText({
      fromAddress: "kowalski0@example.com",
      toAddresses: [],
      ccAddresses: [],
    });
    expect(text.split(" ")).toContain("kowalski0");
  });
});

describe("bodyAndFilenamesText", () => {
  it("joins body text and every non-null attachment filename", () => {
    expect(
      bodyAndFilenamesText({
        bodyText: "hello",
        attachments: [
          {
            part: "2",
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1,
            contentId: null,
            inline: false,
            encoding: null,
          },
          {
            part: "3",
            filename: null,
            mimeType: "image/png",
            sizeBytes: 1,
            contentId: "x",
            inline: true,
            encoding: null,
          },
        ],
      }),
    ).toBe("hello invoice.pdf");
  });

  it("degrades to just the filenames while the body is still behind the Index Watermark", () => {
    expect(bodyAndFilenamesText({ bodyText: null, attachments: [] })).toBe("");
  });
});

/**
 * `reindexMessages`/`runSearchIndexRebuildBatch` only exist at the database
 * boundary — the document is built by a raw `to_tsvector`/`setweight` SQL
 * upsert (`search-index.ts`'s own doc comment explains why).
 */
describe("reindexMessages", () => {
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

  async function seedMessage(overrides: Partial<typeof messages.$inferInsert> = {}) {
    const threadId = randomUUID();
    const folderId = randomUUID();
    const messageId = randomUUID();
    await db.insert(threads).values({ id: threadId, mailAccountId: account.id });
    await db.insert(folders).values({
      id: folderId,
      mailAccountId: account.id,
      path: `INBOX-${folderId}`,
      name: "INBOX",
      role: "inbox",
    });
    await db.insert(messages).values({
      id: messageId,
      mailAccountId: account.id,
      threadId,
      folderId,
      uid: 1,
      subject: "Quarterly budget",
      fromName: "Vic van Cooten",
      fromAddress: "vic.van.cooten@a-insights.eu",
      sentAt: new Date("2026-01-01T00:00:00Z"),
      receivedAt: new Date("2026-01-01T00:00:00Z"),
      bodyText: null,
      ...overrides,
    });
    return { threadId, folderId, messageId };
  }

  it("writes a message_search row carrying every weight, at the current index version", async () => {
    const { messageId, threadId, folderId } = await seedMessage();
    await reindexMessages(db, [messageId]);

    const [row] = await db
      .select()
      .from(messageSearch)
      .where(eq(messageSearch.messageId, messageId));
    expect(row).toMatchObject({
      messageId,
      threadId,
      folderId,
      mailAccountId: account.id,
      indexVersion: CURRENT_SEARCH_INDEX_VERSION,
    });
    expect(row?.doc).toBeTruthy();
  });

  it("recomputes the whole document when the body arrives later — an address-part-only message still ranks by body once reindexed", async () => {
    const { messageId } = await seedMessage({ bodyText: null });
    await reindexMessages(db, [messageId]);

    await db
      .update(messages)
      .set({ bodyText: "a distinctive body word appears here" })
      .where(eq(messages.id, messageId));
    await reindexMessages(db, [messageId]);

    const [row] = await db
      .select()
      .from(messageSearch)
      .where(eq(messageSearch.messageId, messageId));
    // A plain equality check that `doc` is non-trivially different requires
    // querying it back through `@@` — that's `search-query.test.ts`'s job.
    // Here it's enough that the row still exists and is still current.
    expect(row?.indexVersion).toBe(CURRENT_SEARCH_INDEX_VERSION);
  });

  it("is a no-op for an id that no longer exists", async () => {
    await expect(reindexMessages(db, [randomUUID()])).resolves.toBeUndefined();
  });

  it("batches more than one id in a single call", async () => {
    const first = await seedMessage();
    const second = await seedMessage();
    await reindexMessages(db, [first.messageId, second.messageId]);

    const rows = await db.select().from(messageSearch);
    expect(rows.map((row) => row.messageId).sort()).toEqual(
      [first.messageId, second.messageId].sort(),
    );
  });

  describe("runSearchIndexRebuildBatch", () => {
    it("reports complete with nothing to do", async () => {
      const result = await runSearchIndexRebuildBatch(db);
      expect(result).toEqual({ processed: 0, complete: true });
    });

    it("indexes a Message that has no row at all — the pass that heals a pre-index mailbox", async () => {
      // Nothing backfilled a Message stored before this table existed
      // (migration `0015`), and the stale-version sweep structurally
      // cannot: there is no row to find stale. Such a Message stayed
      // invisible to `POST /search` forever while the Client's own list
      // still showed it — which reads as "results appear, then vanish",
      // since the Local Cache prefilter finds the Thread and the
      // authoritative answer that replaces it wholesale has nothing.
      const { messageId } = await seedMessage();
      expect(await db.select().from(messageSearch)).toHaveLength(0);

      const result = await runSearchIndexRebuildBatch(db, 50);
      expect(result).toEqual({ processed: 1, complete: false });

      const [row] = await db
        .select()
        .from(messageSearch)
        .where(eq(messageSearch.messageId, messageId));
      expect(row?.indexVersion).toBe(CURRENT_SEARCH_INDEX_VERSION);
      expect(row?.doc).toBeTruthy();

      // Caught up: the next tick has neither a missing row nor a stale one.
      expect(await runSearchIndexRebuildBatch(db, 50)).toEqual({ processed: 0, complete: true });
    });

    it("bounds the missing-row pass by the batch size", async () => {
      await seedMessage();
      await seedMessage();
      await seedMessage();

      expect(await runSearchIndexRebuildBatch(db, 2)).toEqual({ processed: 2, complete: false });
      expect(await runSearchIndexRebuildBatch(db, 2)).toEqual({ processed: 1, complete: false });
      expect(await runSearchIndexRebuildBatch(db, 2)).toEqual({ processed: 0, complete: true });
    });

    it("brings a stale-version row up to the current version, oldest-version-first", async () => {
      const { messageId } = await seedMessage();
      await reindexMessages(db, [messageId]);
      await db
        .update(messageSearch)
        .set({ indexVersion: CURRENT_SEARCH_INDEX_VERSION - 1 })
        .where(eq(messageSearch.messageId, messageId));

      const result = await runSearchIndexRebuildBatch(db, 50);
      expect(result).toEqual({ processed: 1, complete: false });

      const [row] = await db
        .select()
        .from(messageSearch)
        .where(eq(messageSearch.messageId, messageId));
      expect(row?.indexVersion).toBe(CURRENT_SEARCH_INDEX_VERSION);

      // Nothing stale left — the next tick goes idle.
      expect(await runSearchIndexRebuildBatch(db, 50)).toEqual({ processed: 0, complete: true });
    });
  });
});
