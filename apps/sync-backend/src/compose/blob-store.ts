import { randomUUID } from "node:crypto";
import type { AttachmentDisposition, AttachmentMeta } from "@mail/shared";
import { EMPTY_COMPOSE_DOCUMENT, encodedByteSize } from "@mail/shared";
import { eq } from "drizzle-orm";
import type Mail from "nodemailer/lib/mailer/index.js";
import type { Db } from "../db/client.js";
import { attachmentBlobs, type CompositionRow, compositions } from "../db/schema.js";

/** The transaction handle `db.transaction(async (tx) => ...)` hands its callback — same query surface as `Db`. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The Blob Store (#48, ADR-0012): a narrow put/get/delete-by-id seam over
 * Postgres `bytea`, so a filesystem or S3 implementation could replace it
 * later without touching anything in `routes/attachments.ts` or the mail
 * build (ADR-0012's own consequence: "the seam is what makes it fixable").
 * `compositions.attachments` is the metadata half (ADR-0012: "attachment
 * references"); this file is the bytes half.
 */

export type PutBlobResult =
  | { ok: true; meta: AttachmentMeta }
  | { ok: false; reason: "over_budget"; remainingBytes: number; budgetBytes: number };

/**
 * Stores one attachment's bytes and appends its metadata to the
 * Composition's `attachments` column, creating the Composition row first if
 * this is its first content at all (ADR-0012: "created lazily on first
 * content ... one path shared by autosave and attach"). Both writes are one
 * transaction: a crash between them must never leave a blob nothing
 * references, or a metadata entry pointing at bytes that were never
 * written.
 *
 * The budget is enforced **before** either write — over budget stores
 * nothing, matching compose-spec's "refused at selection time" (the Client
 * is expected to reject even earlier, before the bytes are ever sent; this
 * is the backend's own re-check, ADR-0012: "re-checked in the backend").
 */
export async function putBlob(
  db: Db,
  args: {
    compositionId: string;
    mailAccountId: string;
    bytes: Buffer;
    filename: string;
    mimeType: string;
    disposition: AttachmentDisposition;
    budgetBytes: number;
  },
): Promise<PutBlobResult> {
  const encodedSize = encodedByteSize(args.bytes.length);

  // The budget check reads first, **outside** any write — an over-budget
  // attach must leave nothing behind, not even the lazy Composition row a
  // successful attach would have created. A concurrent attach from the same
  // composer slipping past this read and the write below is the one
  // accepted race: the budget is a live UX guardrail, not a billing limit,
  // and the Client is expected to have already refused the same file before
  // this request was ever sent.
  const existing = await getCompositionForAttachment(db, args.compositionId);
  const usedBytes = (existing?.attachments ?? []).reduce(
    (total, entry) => total + encodedByteSize(entry.sizeBytes),
    0,
  );
  const remainingBytes = args.budgetBytes - usedBytes;
  if (encodedSize > remainingBytes) {
    return {
      ok: false,
      reason: "over_budget",
      remainingBytes: Math.max(0, remainingBytes),
      budgetBytes: args.budgetBytes,
    };
  }

  return db.transaction(async (tx) => {
    const row = existing ?? (await ensureComposition(tx, args.mailAccountId, args.compositionId));

    const id = randomUUID();
    await tx
      .insert(attachmentBlobs)
      .values({ id, compositionId: args.compositionId, bytes: args.bytes });

    const meta: AttachmentMeta = {
      id,
      filename: args.filename,
      mimeType: args.mimeType,
      sizeBytes: args.bytes.length,
      disposition: args.disposition,
      contentId: args.disposition === "inline" ? `${id}@mail.local` : null,
      createdAt: new Date().toISOString(),
    };
    await tx
      .update(compositions)
      .set({ attachments: [...row.attachments, meta], updatedAt: new Date() })
      .where(eq(compositions.id, args.compositionId));

    return { ok: true, meta };
  });
}

/** The Composition row this attachment belongs to, for the ownership check in `routes/attachments.ts`. */
export async function getCompositionForAttachment(
  db: Db,
  compositionId: string,
): Promise<CompositionRow | null> {
  const [row] = await db
    .select()
    .from(compositions)
    .where(eq(compositions.id, compositionId))
    .limit(1);
  return row ?? null;
}

/** One blob's raw bytes, for the download route — `null` when the id is unknown. */
export async function getBlobBytes(db: Db, attachmentId: string): Promise<Buffer | null> {
  const [row] = await db
    .select({ bytes: attachmentBlobs.bytes })
    .from(attachmentBlobs)
    .where(eq(attachmentBlobs.id, attachmentId))
    .limit(1);
  return row?.bytes ?? null;
}

export type DeleteBlobResult = { status: "deleted" } | { status: "not_found" };

/**
 * Removes one attachment: the blob row and its metadata entry, in one
 * transaction — "deletion propagates outward only" (the ticket): removing a
 * Blob Store entry always drops its reference on the Composition, but
 * nothing about editing the document (e.g. deleting an inline image node)
 * ever reaches back to delete a blob. That direction is the explicit Remove
 * button alone.
 */
export async function deleteBlob(
  db: Db,
  compositionId: string,
  attachmentId: string,
): Promise<DeleteBlobResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ attachments: compositions.attachments })
      .from(compositions)
      .where(eq(compositions.id, compositionId))
      .limit(1);
    if (!row) return { status: "not_found" };
    if (!row.attachments.some((entry) => entry.id === attachmentId)) return { status: "not_found" };

    await tx.delete(attachmentBlobs).where(eq(attachmentBlobs.id, attachmentId));
    await tx
      .update(compositions)
      .set({
        attachments: row.attachments.filter((entry) => entry.id !== attachmentId),
        updatedAt: new Date(),
      })
      .where(eq(compositions.id, compositionId));
    return { status: "deleted" };
  });
}

/**
 * Drops every blob belonging to one Composition, without touching its
 * `attachments` metadata column — the caller (`compose/send-sweeper.ts`,
 * right after the `Sent` `APPEND`) is about to delete the Composition itself
 * shortly via `pending-send.ts#pruneSentCompositions`, so there is nothing
 * left to keep that column in sync with. Cancelling a send never calls
 * this: cancel is a status change back to `draft` with the content —
 * attachments included — untouched (ADR-0012's lifecycle: only a
 * successful send drops blobs).
 */
export async function deleteBlobsForComposition(db: Db, compositionId: string): Promise<void> {
  await db.delete(attachmentBlobs).where(eq(attachmentBlobs.compositionId, compositionId));
}

/**
 * The lazy Composition row creation attach-first shares with autosave
 * (ADR-0012): an id the account has never seen starts a brand-new `draft`
 * row with the empty document, exactly what `sync/compose-store.ts#applySave`
 * does for a first keystroke. An existing row — of any status or version —
 * is returned untouched; attach never bumps `version`, since nothing about
 * the authored content changed.
 */
async function ensureComposition(
  tx: Tx,
  mailAccountId: string,
  compositionId: string,
): Promise<CompositionRow> {
  const [existing] = await tx
    .select()
    .from(compositions)
    .where(eq(compositions.id, compositionId))
    .limit(1);
  if (existing) return existing;

  const [created] = await tx
    .insert(compositions)
    .values({
      id: compositionId,
      mailAccountId,
      document: EMPTY_COMPOSE_DOCUMENT,
      version: 0,
    })
    .returning();
  if (!created) throw new Error("failed to create Composition row for attach");
  return created;
}

/**
 * Loads every attached blob's bytes and shapes them into what Nodemailer's
 * `MailComposer` expects — the one place that turns `compositions.attachments`
 * plus the Blob Store into a MIME tree. Nodemailer already nests a `cid`
 * attachment inside `multipart/related` and every other attachment as a
 * `multipart/mixed` sibling on its own, which is exactly ADR-0012's shape
 * (`multipart/mixed` [ `multipart/related` [ `multipart/alternative`
 * [ text, html ], inline parts ], attachments ]) — nothing here builds MIME
 * by hand.
 */
export async function attachmentsForMailOptions(
  db: Db,
  row: CompositionRow,
): Promise<Mail.Attachment[]> {
  const built: Mail.Attachment[] = [];
  for (const meta of row.attachments) {
    const bytes = await getBlobBytes(db, meta.id);
    if (!bytes) continue; // deleted concurrently — omit rather than fail the whole send
    built.push({
      filename: meta.filename,
      content: bytes,
      contentType: meta.mimeType,
      contentDisposition: meta.disposition,
      ...(meta.disposition === "inline" && meta.contentId ? { cid: meta.contentId } : {}),
    });
  }
  return built;
}
