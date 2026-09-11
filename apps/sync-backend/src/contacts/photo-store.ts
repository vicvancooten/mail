import { createHash } from "node:crypto";
import type { ContactPhoto, ContactPhotoMimeType } from "@mail/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { contactPhotoBlobs, contacts } from "../db/schema.js";
import {
  enqueueContactCarddavPhotoWriteBack,
  enqueueContactPhotoWriteBack,
} from "./write-back-outbox.js";

/** `contacts.photo->>'blobId'`, as a reusable SQL fragment — every reader of a Contact's photo reference by blob id goes through this one expression. */
const contactPhotoBlobIdExpr = sql`${contacts.photo} ->> 'blobId'`;

/**
 * A Contact photo's own Blob Store seam (#213, ADR-0012 generalized): put,
 * get and the reference update that rides on a Contact row, plus the
 * collection step an unreferenced blob needs since — unlike
 * `compose/blob-store.ts`'s attachments — this store is content-addressed
 * and has no owning-row FK to cascade a delete from
 * (`db/schema.ts#contactPhotoBlobs`'s own doc comment).
 */

export type PutContactPhotoResult =
  | { ok: true; photo: ContactPhoto }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "over_budget"; maxBytes: number };

/**
 * Stores one photo's bytes and points `contactId`'s `photo` column at it —
 * both in one transaction, the same "never a reference to bytes that were
 * never written" discipline `putBlob` (`compose/blob-store.ts`) keeps. The
 * blob id is `bytes`' own sha256 hex digest: re-uploading the exact same
 * image (for this Contact or another) reuses the existing row
 * (`onConflictDoNothing`) rather than storing a second copy, which is the
 * ticket's own "served ... by content hash" line.
 *
 * The Contact's *previous* photo, if it had one, is collected afterward
 * (`collectOrphanedBlob`) — the ticket's "orphaned blobs are collectable"
 * acceptance line, applied eagerly at the moment a reference is dropped
 * rather than deferred to a separate sweep.
 */
export async function putContactPhoto(
  db: Db,
  args: {
    userId: string;
    contactId: string;
    bytes: Buffer;
    mimeType: ContactPhotoMimeType;
    maxBytes: number;
  },
): Promise<PutContactPhotoResult> {
  if (args.bytes.length > args.maxBytes) {
    return { ok: false, reason: "over_budget", maxBytes: args.maxBytes };
  }

  const blobId = createHash("sha256").update(args.bytes).digest("hex");
  const photo: ContactPhoto = { blobId, mimeType: args.mimeType };

  const previousBlobId = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        photo: contacts.photo,
        addressBookId: contacts.addressBookId,
        connectedAccountId: contacts.connectedAccountId,
        googleResourceName: contacts.googleResourceName,
        carddavHref: contacts.carddavHref,
      })
      .from(contacts)
      .where(and(eq(contacts.id, args.contactId), eq(contacts.userId, args.userId)))
      .limit(1);
    if (!row) return undefined;

    await tx
      .insert(contactPhotoBlobs)
      .values({ id: blobId, mimeType: args.mimeType, bytes: args.bytes })
      .onConflictDoNothing({ target: contactPhotoBlobs.id });

    await tx
      .update(contacts)
      .set({ photo, updatedAt: new Date() })
      .where(eq(contacts.id, args.contactId));

    // A mirrored Google/CardDAV Contact's own photo write-back (#216, #226)
    // — `updateContactPhoto`, categorically separate from the field write
    // (`sync/mutations.ts#applyUserIntent`'s own `updateContact` case, this
    // ticket's own acceptance line). `row.photo` here is the *previous*
    // value — the rollback target the outbox row snapshots, never this
    // upload's own new reference.
    if (row.connectedAccountId && row.googleResourceName) {
      await enqueueContactPhotoWriteBack(tx, {
        contactId: args.contactId,
        connectedAccountId: row.connectedAccountId,
        previousPhoto: row.photo,
      });
    } else if (row.carddavHref) {
      await enqueueContactCarddavPhotoWriteBack(tx, {
        contactId: args.contactId,
        addressBookId: row.addressBookId,
        previousPhoto: row.photo,
      });
    }

    return row.photo?.blobId ?? null;
  });

  if (previousBlobId === undefined) return { ok: false, reason: "not_found" };
  if (previousBlobId !== null && previousBlobId !== blobId) {
    await collectOrphanedBlob(db, previousBlobId);
  }
  return { ok: true, photo };
}

export type RemoveContactPhotoResult = { status: "removed" } | { status: "not_found" };

/** Clears `contactId`'s `photo` reference and collects the blob it pointed at, if nothing else still names it. */
export async function removeContactPhoto(
  db: Db,
  userId: string,
  contactId: string,
): Promise<RemoveContactPhotoResult> {
  const previousBlobId = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        photo: contacts.photo,
        addressBookId: contacts.addressBookId,
        connectedAccountId: contacts.connectedAccountId,
        googleResourceName: contacts.googleResourceName,
        carddavHref: contacts.carddavHref,
      })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
      .limit(1);
    if (!row) return undefined;
    if (!row.photo) return null;

    await tx
      .update(contacts)
      .set({ photo: null, updatedAt: new Date() })
      .where(eq(contacts.id, contactId));

    // `putContactPhoto`'s own write-back (#216, #226) — a removal is
    // `deleteContactPhoto` upstream once the outbox drains it
    // (`google/write-back-loop.ts`/`carddav/write-back-loop.ts`), same
    // rollback shape either way.
    if (row.connectedAccountId && row.googleResourceName) {
      await enqueueContactPhotoWriteBack(tx, {
        contactId,
        connectedAccountId: row.connectedAccountId,
        previousPhoto: row.photo,
      });
    } else if (row.carddavHref) {
      await enqueueContactCarddavPhotoWriteBack(tx, {
        contactId,
        addressBookId: row.addressBookId,
        previousPhoto: row.photo,
      });
    }

    return row.photo.blobId;
  });

  if (previousBlobId === undefined) return { status: "not_found" };
  if (previousBlobId !== null) await collectOrphanedBlob(db, previousBlobId);
  return { status: "removed" };
}

/** One Contact's photo blob, for the download route — `null` when the Contact holds no photo or the blob is somehow already gone. */
export async function getContactPhotoBlob(
  db: Db,
  userId: string,
  contactId: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const [contact] = await db
    .select({ photo: contacts.photo })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .limit(1);
  if (!contact?.photo) return null;

  const [blob] = await db
    .select({ bytes: contactPhotoBlobs.bytes, mimeType: contactPhotoBlobs.mimeType })
    .from(contactPhotoBlobs)
    .where(eq(contactPhotoBlobs.id, contact.photo.blobId))
    .limit(1);
  return blob ?? null;
}

/**
 * Deletes `blobId`'s row if — and only if — no Contact's `photo` still
 * names it. Reads and deletes are not one atomic statement, so a photo
 * upload racing this exact blob into a *second* Contact between the read
 * and the delete is the one accepted race (mirroring `putBlob`'s own
 * accepted-race doc comment in `compose/blob-store.ts`): losing it costs a
 * re-upload of an image the User still has locally, never data no client
 * holds a copy of.
 */
export async function collectOrphanedBlob(db: Db | Tx, blobId: string): Promise<void> {
  const [stillReferenced] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contactPhotoBlobIdExpr, blobId))
    .limit(1);
  if (stillReferenced) return;
  await db.delete(contactPhotoBlobs).where(eq(contactPhotoBlobs.id, blobId));
}

/**
 * Every blob no Contact's `photo` currently names, collected in one pass —
 * exposed for an operator sweep/test, never called from the request path
 * itself (each request already collects its own one displaced blob via
 * `collectOrphanedBlob` above).
 */
export async function sweepOrphanedContactPhotoBlobs(db: Db): Promise<number> {
  const orphans = await db
    .select({ id: contactPhotoBlobs.id })
    .from(contactPhotoBlobs)
    .leftJoin(contacts, eq(contactPhotoBlobIdExpr, contactPhotoBlobs.id))
    .groupBy(contactPhotoBlobs.id)
    .having(sql`count(${contacts.id}) = 0`);
  for (const orphan of orphans) {
    await db.delete(contactPhotoBlobs).where(eq(contactPhotoBlobs.id, orphan.id));
  }
  return orphans.length;
}
