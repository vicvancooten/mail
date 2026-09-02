import { randomUUID } from "node:crypto";
import { encodedByteSize } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { attachmentBlobs, compositions } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  attachmentsForMailOptions,
  deleteBlob,
  deleteBlobsForComposition,
  getBlobBytes,
  putBlob,
} from "./blob-store.js";

/**
 * The Blob Store's own seam (#48, ADR-0012): lazy Composition creation
 * shared with autosave, the live budget re-check, "deletion propagates
 * outward only", and the cascade delete that makes the orphan sweeper
 * unnecessary by construction.
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

const BUDGET = 1_000; // small budget, exercised deliberately in these tests

describe("putBlob", () => {
  it("creates the Composition row lazily on the first attach, the same path autosave uses", async () => {
    const compositionId = randomUUID();
    expect(await db.select().from(compositions).where(eq(compositions.id, compositionId))).toEqual(
      [],
    );

    const result = await putBlob(db, {
      compositionId,
      mailAccountId: account.id,
      bytes: Buffer.from("hello"),
      filename: "hello.txt",
      mimeType: "text/plain",
      disposition: "attachment",
      budgetBytes: BUDGET,
    });

    expect(result.ok).toBe(true);
    const [row] = await db.select().from(compositions).where(eq(compositions.id, compositionId));
    expect(row?.status).toBe("draft");
    expect(row?.attachments).toHaveLength(1);
    expect(row?.attachments[0]).toMatchObject({ filename: "hello.txt", sizeBytes: 5 });
  });

  it("appends to an existing Composition's attachments without touching its content", async () => {
    const compositionId = randomUUID();
    await db.insert(compositions).values({
      id: compositionId,
      mailAccountId: account.id,
      subject: "Already typing",
      document: { type: "doc", content: [{ type: "paragraph" }] },
      version: 3,
    });

    const result = await putBlob(db, {
      compositionId,
      mailAccountId: account.id,
      bytes: Buffer.from("bytes"),
      filename: "a.png",
      mimeType: "image/png",
      disposition: "inline",
      budgetBytes: BUDGET,
    });
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(compositions).where(eq(compositions.id, compositionId));
    expect(row?.subject).toBe("Already typing"); // untouched
    expect(row?.version).toBe(3); // attach never bumps version
    expect(row?.attachments).toHaveLength(1);
    expect(row?.attachments[0]?.disposition).toBe("inline");
    expect(row?.attachments[0]?.contentId).toBeTruthy();
  });

  it("rejects over the encoded budget and stores nothing, reporting the remaining space", async () => {
    const compositionId = randomUUID();
    // 1000-byte budget; a 900-byte file encodes to 1200 bytes (base64 4/3).
    const bytes = Buffer.alloc(900);
    const result = await putBlob(db, {
      compositionId,
      mailAccountId: account.id,
      bytes,
      filename: "big.bin",
      mimeType: "application/octet-stream",
      disposition: "attachment",
      budgetBytes: BUDGET,
    });

    expect(result).toEqual({
      ok: false,
      reason: "over_budget",
      remainingBytes: BUDGET,
      budgetBytes: BUDGET,
    });
    expect(await db.select().from(attachmentBlobs)).toEqual([]);
    // Even the lazy Composition row must not be created by a rejected attach.
    expect(await db.select().from(compositions).where(eq(compositions.id, compositionId))).toEqual(
      [],
    );
  });

  it("counts already-attached files against the budget for the next one", async () => {
    const compositionId = randomUUID();
    const first = await putBlob(db, {
      compositionId,
      mailAccountId: account.id,
      bytes: Buffer.alloc(600), // encodes to 800
      filename: "one.bin",
      mimeType: "application/octet-stream",
      disposition: "attachment",
      budgetBytes: BUDGET,
    });
    expect(first.ok).toBe(true);

    // 200 bytes left; a 200-byte file encodes to 268, which is over.
    const second = await putBlob(db, {
      compositionId,
      mailAccountId: account.id,
      bytes: Buffer.alloc(200),
      filename: "two.bin",
      mimeType: "application/octet-stream",
      disposition: "attachment",
      budgetBytes: BUDGET,
    });
    expect(second).toMatchObject({ ok: false, reason: "over_budget", remainingBytes: 200 });
  });
});

describe("deleteBlob", () => {
  it("drops the bytes and the Composition's own reference together", async () => {
    const compositionId = randomUUID();
    const { meta } = requireOk(
      await putBlob(db, {
        compositionId,
        mailAccountId: account.id,
        bytes: Buffer.from("x"),
        filename: "x.txt",
        mimeType: "text/plain",
        disposition: "attachment",
        budgetBytes: BUDGET,
      }),
    );

    expect(await deleteBlob(db, compositionId, meta.id)).toEqual({ status: "deleted" });
    expect(await getBlobBytes(db, meta.id)).toBeNull();
    const [row] = await db.select().from(compositions).where(eq(compositions.id, compositionId));
    expect(row?.attachments).toEqual([]);
  });

  it("reports not_found for an id that never belonged to this Composition", async () => {
    const compositionId = randomUUID();
    await db.insert(compositions).values({
      id: compositionId,
      mailAccountId: account.id,
      document: { type: "doc", content: [{ type: "paragraph" }] },
      version: 0,
    });
    expect(await deleteBlob(db, compositionId, "not-a-real-id")).toEqual({ status: "not_found" });
  });
});

describe("deleteBlobsForComposition", () => {
  it("drops every blob but leaves the metadata column as-is (the caller is about to delete the row)", async () => {
    const compositionId = randomUUID();
    const { meta } = requireOk(
      await putBlob(db, {
        compositionId,
        mailAccountId: account.id,
        bytes: Buffer.from("x"),
        filename: "x.txt",
        mimeType: "text/plain",
        disposition: "attachment",
        budgetBytes: BUDGET,
      }),
    );

    await deleteBlobsForComposition(db, compositionId);
    expect(await getBlobBytes(db, meta.id)).toBeNull();
  });
});

describe("cascade delete", () => {
  it("deleting the Composition deletes its blobs — no orphan sweeper needed", async () => {
    const compositionId = randomUUID();
    const { meta } = requireOk(
      await putBlob(db, {
        compositionId,
        mailAccountId: account.id,
        bytes: Buffer.from("x"),
        filename: "x.txt",
        mimeType: "text/plain",
        disposition: "attachment",
        budgetBytes: BUDGET,
      }),
    );

    await db.delete(compositions).where(eq(compositions.id, compositionId));
    expect(await getBlobBytes(db, meta.id)).toBeNull();
  });
});

describe("attachmentsForMailOptions", () => {
  it("shapes the Blob Store's bytes into Nodemailer attachment options, cid only for inline", async () => {
    const compositionId = randomUUID();
    const attached = requireOk(
      await putBlob(db, {
        compositionId,
        mailAccountId: account.id,
        bytes: Buffer.from("file bytes"),
        filename: "report.pdf",
        mimeType: "application/pdf",
        disposition: "attachment",
        budgetBytes: BUDGET,
      }),
    );
    const inline = requireOk(
      await putBlob(db, {
        compositionId,
        mailAccountId: account.id,
        bytes: Buffer.from("img bytes"),
        filename: "photo.png",
        mimeType: "image/png",
        disposition: "inline",
        budgetBytes: BUDGET,
      }),
    );

    const [row] = await db.select().from(compositions).where(eq(compositions.id, compositionId));
    if (!row) throw new Error("expected a row");
    const built = await attachmentsForMailOptions(db, row);

    expect(built).toHaveLength(2);
    const asAttachment = built.find((entry) => entry.filename === "report.pdf");
    if (!asAttachment) throw new Error("expected the attachment-disposition part");
    expect(asAttachment).toMatchObject({ contentDisposition: "attachment" });
    expect(asAttachment.cid).toBeUndefined();
    const asInline = built.find((entry) => entry.filename === "photo.png");
    expect(asInline).toMatchObject({ contentDisposition: "inline", cid: inline.meta.contentId });
    expect((asAttachment.content as Buffer).toString("utf8")).toBe("file bytes");
    void attached;
  });
});

it("encodedByteSize matches base64's 3-in/4-out inflation", () => {
  expect(encodedByteSize(3)).toBe(4);
  expect(encodedByteSize(1)).toBe(4); // padded up to the next 4-char group
  expect(encodedByteSize(0)).toBe(0);
});

function requireOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error("expected putBlob to succeed");
  return result as Extract<T, { ok: true }>;
}
