import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { attachmentBlobs, compositions } from "../db/schema.js";

/**
 * Delete (#101, ADR-0012's "deletion is asymmetric: a Mail-side delete
 * expunges the IMAP copy"). This file is the synchronous half — the status
 * flip and the blob drop, both instant and IMAP-free — mirroring
 * `compose/pending-send.ts`'s own conditional-transition shape exactly.
 * The IMAP side (`expungeDraftCopy`, moved to `sync/draft-push.ts` so this
 * and `compose/send-sweeper.ts` share one implementation) runs asynchronously
 * off `status: "discarded"` and a still-live `imap_draft_uid`, on the
 * debounced push loop's own interval (`sync/draft-push-loop.ts`) — never
 * inline here, for the same reason no other Optimistic Action opens an IMAP
 * connection inside the `POST /sync` request that queued it.
 */

export type DiscardCompositionResult =
  | { status: "discarded" }
  | { status: "rejected"; reason: "not_found" | "not_a_draft" };

/**
 * `draft → discarded`. Attachment blobs are dropped in the same transaction
 * as the status flip — cheap, IMAP-free, and, unlike the expunge, there is no
 * reason to defer it. The Composition's own `attachments` metadata column is
 * cleared alongside them, unlike `blob-store.ts#deleteBlobsForComposition`'s
 * own "leave it, the row is about to be deleted anyway" — this row survives
 * discard, so leaving stale metadata pointing at bytes that are already gone
 * would be the row lying about what it holds.
 *
 * This is the one place attachments are lost to Delete: `undiscardComposition`
 * below restores `draft` but not the blobs, a deliberate, documented
 * trade-off (the ticket's own "delete blobs") rather than an oversight —
 * see ADR-0012's "Undo of Discard restores the Draft, not its attachments"
 * amendment for why undoing the status Discard changed is not the same
 * promise as undoing everything it touched.
 */
export async function discardComposition(
  db: Db,
  mailAccountId: string,
  compositionId: string,
  now: Date = new Date(),
): Promise<DiscardCompositionResult> {
  return db.transaction(async (tx) => {
    const discarded = await tx
      .update(compositions)
      .set({ status: "discarded", attachments: [], updatedAt: now })
      .where(
        and(
          eq(compositions.id, compositionId),
          eq(compositions.mailAccountId, mailAccountId),
          eq(compositions.status, "draft"),
        ),
      )
      .returning({ id: compositions.id });

    if (discarded.length === 0) {
      const [row] = await tx
        .select({ id: compositions.id })
        .from(compositions)
        .where(
          and(eq(compositions.id, compositionId), eq(compositions.mailAccountId, mailAccountId)),
        )
        .limit(1);
      return row
        ? { status: "rejected", reason: "not_a_draft" }
        : { status: "rejected", reason: "not_found" };
    }

    await tx.delete(attachmentBlobs).where(eq(attachmentBlobs.compositionId, compositionId));
    return { status: "discarded" };
  });
}

export type UndiscardCompositionResult =
  | { status: "undiscarded" }
  | { status: "rejected"; reason: "not_found" | "not_discarded" };

/**
 * Undo's real inverse (#95, ADR-0019): `discarded → draft`. Deliberately
 * leaves `imap_draft_uid`/`pushed_content_hash` untouched — whichever of the
 * two states they are still in is the correct one to resume from: still
 * pointing at a live UID (the expunge hasn't run yet) means the IMAP copy
 * never moved and there is nothing to re-push; already cleared (the expunge
 * beat this Undo) means the ordinary push-pending query's content-hash
 * mismatch picks the row back up on its own next tick. Either way, this
 * function has no IMAP bookkeeping of its own to get right.
 */
export async function undiscardComposition(
  db: Db,
  mailAccountId: string,
  compositionId: string,
  now: Date = new Date(),
): Promise<UndiscardCompositionResult> {
  const restored = await db
    .update(compositions)
    .set({ status: "draft", updatedAt: now })
    .where(
      and(
        eq(compositions.id, compositionId),
        eq(compositions.mailAccountId, mailAccountId),
        eq(compositions.status, "discarded"),
      ),
    )
    .returning({ id: compositions.id });
  if (restored.length > 0) return { status: "undiscarded" };

  const [row] = await db
    .select({ id: compositions.id })
    .from(compositions)
    .where(and(eq(compositions.id, compositionId), eq(compositions.mailAccountId, mailAccountId)))
    .limit(1);
  return row
    ? { status: "rejected", reason: "not_discarded" }
    : { status: "rejected", reason: "not_found" };
}
