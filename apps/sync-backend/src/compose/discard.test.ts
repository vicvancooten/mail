import { randomUUID } from "node:crypto";
import type { ComposeDocument } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { attachmentBlobs, compositions } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { discardComposition, undiscardComposition } from "./discard.js";

/**
 * Delete's synchronous half (#101, ADR-0012's "deletion is asymmetric"): the
 * status flip, the attachment blob drop, and the conditional-transition
 * rejections — everything that does *not* touch IMAP. The async expunge
 * itself is `sync/draft-push.test.ts`'s (well, its own test file once one
 * exists — today covered end to end by `draft-push.greenmail.test.ts`).
 */

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;

const DOC: ComposeDocument = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

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

async function insertComposition(overrides: Partial<typeof compositions.$inferInsert> = {}) {
  const id = overrides.id ?? randomUUID();
  await db.insert(compositions).values({
    id,
    mailAccountId: account.id,
    subject: "Subject",
    document: DOC,
    version: 1,
    ...overrides,
  });
  return id;
}

async function row(id: string) {
  const [found] = await db.select().from(compositions).where(eq(compositions.id, id)).limit(1);
  if (!found) throw new Error("composition row vanished");
  return found;
}

describe("discardComposition", () => {
  it("marks a Draft discarded and drops its attachment blobs and metadata", async () => {
    const id = await insertComposition({
      attachments: [
        {
          id: "blob-1",
          filename: "a.png",
          mimeType: "image/png",
          sizeBytes: 3,
          disposition: "attachment",
          contentId: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await db
      .insert(attachmentBlobs)
      .values({ id: "blob-1", compositionId: id, bytes: Buffer.from("abc") });

    const result = await discardComposition(db, account.id, id);

    expect(result).toEqual({ status: "discarded" });
    const after = await row(id);
    expect(after.status).toBe("discarded");
    expect(after.attachments).toEqual([]);
    const [blob] = await db
      .select()
      .from(attachmentBlobs)
      .where(eq(attachmentBlobs.compositionId, id));
    expect(blob).toBeUndefined();
  });

  it("rejects a Composition that isn't a Draft, without touching it", async () => {
    const id = await insertComposition({ status: "pending" });

    const result = await discardComposition(db, account.id, id);

    expect(result).toEqual({ status: "rejected", reason: "not_a_draft" });
    expect((await row(id)).status).toBe("pending");
  });

  it("rejects a Composition id this Mail Account doesn't have", async () => {
    const result = await discardComposition(db, account.id, randomUUID());
    expect(result).toEqual({ status: "rejected", reason: "not_found" });
  });

  it("leaves imap_draft_uid/pushed_content_hash untouched — the async expunge owns clearing them", async () => {
    const id = await insertComposition({ imapDraftUid: 42, pushedContentHash: "abc123" });

    await discardComposition(db, account.id, id);

    const after = await row(id);
    expect(after.imapDraftUid).toBe(42);
    expect(after.pushedContentHash).toBe("abc123");
  });
});

describe("undiscardComposition", () => {
  it("restores a discarded Composition to draft — Undo's real inverse (#95)", async () => {
    const id = await insertComposition({ status: "discarded" });

    const result = await undiscardComposition(db, account.id, id);

    expect(result).toEqual({ status: "undiscarded" });
    expect((await row(id)).status).toBe("draft");
  });

  it("rejects a Composition that isn't discarded", async () => {
    const id = await insertComposition({ status: "draft" });

    const result = await undiscardComposition(db, account.id, id);

    expect(result).toEqual({ status: "rejected", reason: "not_discarded" });
    expect((await row(id)).status).toBe("draft");
  });

  it("rejects a Composition id this Mail Account doesn't have", async () => {
    const result = await undiscardComposition(db, account.id, randomUUID());
    expect(result).toEqual({ status: "rejected", reason: "not_found" });
  });
});
