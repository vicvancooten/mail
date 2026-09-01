import type {
  ComposeDocument,
  ComposeNode,
  ComposeSave,
  ComposeSaveOutcome,
  Recipient,
} from "@mail/shared";
import { EMPTY_COMPOSE_DOCUMENT } from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import type { CachedComposition, PendingComposeSave } from "./db.js";
import { localCache } from "./local-cache.js";
import { generateUlid } from "./ulid.js";

/**
 * A Composition's Local Cache row and its coalescing autosave queue
 * (ADR-0014, #45) — component-facing read and write together, `sync/`-facing
 * flush together, the same "one focused concern, one module" shape
 * `cache-pins.ts` uses (see `db.ts#CachedComposition`'s doc comment for why
 * this does not split along `reads.ts`/`mutation-queue.ts`'s line).
 */

export interface ComposeContent {
  subject: string;
  document: ComposeDocument;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
}

export const EMPTY_COMPOSE_CONTENT: ComposeContent = {
  subject: "",
  document: EMPTY_COMPOSE_DOCUMENT,
  to: [],
  cc: [],
  bcc: [],
};

/** A fresh Composition id, mintable before any content exists — the composer opens with one immediately. */
export function newCompositionId(): string {
  return generateUlid();
}

export function useComposition(id: string | null): CachedComposition | undefined {
  return useLiveQuery(() => readComposition(id), [id]);
}

async function readComposition(id: string | null): Promise<CachedComposition | undefined> {
  if (id === null) return undefined;
  return localCache().compositions.get(id);
}

/**
 * Writes one autosave. The Composition row is created lazily right here, on
 * whatever the first call happens to be (ADR-0012: "created lazily on first
 * content") — there is no separate `createComposition`. Both the durable
 * content row and the coalescing queue row are written in one transaction,
 * so a reload between them can never observe one without the other.
 *
 * Coalescing is `pendingComposeSaves.put()`'s own upsert semantics: a second
 * call for the same `id` before the first has flushed simply overwrites the
 * queued row — ADR-0014's "the single deliberate exception to the FIFO,
 * additive intent queue," bought here with no cancellation logic, unlike
 * `mutation-queue.ts`'s inverse-cancels-out case.
 */
export async function saveComposition(
  id: string,
  mailAccountId: string,
  content: ComposeContent,
): Promise<void> {
  const db = localCache();
  const now = new Date().toISOString();
  await db.transaction("rw", [db.compositions, db.pendingComposeSaves], async () => {
    const existing = await db.compositions.get(id);
    // ADR-0012: "created lazily on first content." A composer opened and
    // closed without a keystroke must leave nothing behind — an *existing*
    // row is still written through even if the User deletes everything back
    // to blank, since that is an ordinary edit, not a creation.
    if (!existing && isComposeContentEmpty(content)) return;
    const row: CachedComposition = {
      id,
      mailAccountId,
      status: "draft",
      ...content,
      version: existing?.version ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await db.compositions.put(row);
    await enqueueSave(db, id, mailAccountId, content, now);
  });
}

async function enqueueSave(
  db: ReturnType<typeof localCache>,
  compositionId: string,
  mailAccountId: string,
  content: ComposeContent,
  queuedAt: string,
): Promise<void> {
  const save: PendingComposeSave = {
    compositionId,
    mailAccountId,
    saveId: generateUlid(),
    ...content,
    queuedAt,
  };
  await db.pendingComposeSaves.put(save);
}

/** This Mail Account's queued autosaves — at most one per Composition, order otherwise unpromised. */
export async function listQueuedComposeSaves(mailAccountId: string): Promise<PendingComposeSave[]> {
  return localCache().pendingComposeSaves.where("mailAccountId").equals(mailAccountId).toArray();
}

/**
 * Builds the wire `ComposeSave` for one queued row: `version` is read fresh
 * from the Composition's *current* local row rather than carried on the
 * queue row itself (`db.ts#PendingComposeSave`'s doc comment) — the fix for
 * the race where an in-flight save's response bumps the version while a
 * newer, already-coalesced save is still waiting to go out.
 */
export async function toWireComposeSave(pending: PendingComposeSave): Promise<ComposeSave> {
  const composition = await localCache().compositions.get(pending.compositionId);
  return {
    id: pending.compositionId,
    saveId: pending.saveId,
    version: composition?.version ?? 0,
    subject: pending.subject,
    document: pending.document,
    to: pending.to,
    cc: pending.cc,
    bcc: pending.bcc,
  };
}

/**
 * Resolves outcomes for a round's flushed saves. `applied`/`conflict` both
 * carry the server's authoritative `version`, which is recorded either way —
 * a `conflict` is never silently discarded, it is an accepted fact about
 * where the server now stands. A queued row is only dequeued when its own
 * `saveId` still matches the outcome's: a newer, already-coalesced save
 * overwrote it mid-flight, and *that* save is what gets sent next, never
 * this stale outcome's.
 *
 * A `conflict` additionally **re-queues** the Composition's current content
 * (freshly re-read, so it reflects anything typed since) against the
 * now-corrected version — ADR-0012's "the Client reports that the draft
 * changed on another device" is a real state (`subscribeComposeConflicts`
 * below), but at this ticket's scope, with no cross-device content pull yet,
 * the Client's own unsaved edit is never destroyed and is simply retried
 * rather than left to require a manual resolution nothing here can offer.
 */
export async function resolveComposeSaveOutcomes(
  mailAccountId: string,
  queued: ComposeSave[],
  outcomes: ComposeSaveOutcome[],
): Promise<void> {
  const db = localCache();
  const byId = new Map(queued.map((save) => [save.id, save]));

  for (const outcome of outcomes) {
    await db.transaction("rw", [db.compositions, db.pendingComposeSaves], async () => {
      if (outcome.status !== "rejected") {
        const composition = await db.compositions.get(outcome.id);
        if (composition) await db.compositions.put({ ...composition, version: outcome.version });
      }

      const stillQueued = await db.pendingComposeSaves.get(outcome.id);
      if (!stillQueued || stillQueued.saveId !== outcome.saveId) return; // superseded mid-flight; leave it queued
      await db.pendingComposeSaves.delete(outcome.id);

      if (outcome.status === "conflict") {
        const composition = await db.compositions.get(outcome.id);
        if (composition) {
          await enqueueSave(
            db,
            outcome.id,
            mailAccountId,
            {
              subject: composition.subject,
              document: composition.document,
              to: composition.to,
              cc: composition.cc,
              bcc: composition.bcc,
            },
            new Date().toISOString(),
          );
        }
      }
    });

    if (outcome.status === "conflict") {
      const save = byId.get(outcome.id);
      if (save) notifyConflict({ mailAccountId, compositionId: outcome.id });
    }
  }
}

/** Whether a save carries nothing worth creating a Composition for (ADR-0012: "created lazily on first content"). */
export function isComposeContentEmpty(content: ComposeContent): boolean {
  if (content.subject.trim().length > 0) return false;
  if (content.to.length > 0 || content.cc.length > 0 || content.bcc.length > 0) return false;
  return content.document.content.every(isNodeEmpty);
}

function isNodeEmpty(node: ComposeNode): boolean {
  if (node.type === "text") return (node.text ?? "").trim().length === 0;
  // A node with no text but a meaning of its own — an image, a divider —
  // is content the empty-document check must not swallow.
  if (node.content === undefined) return node.type === "paragraph";
  return node.content.every(isNodeEmpty);
}

export interface ComposeSaveConflict {
  mailAccountId: string;
  compositionId: string;
}

const conflictListeners = new Set<(conflict: ComposeSaveConflict) => void>();

/** Seam for a future "this draft changed on another device" UI (ADR-0014). Nothing subscribes yet. */
export function subscribeComposeConflicts(
  listener: (conflict: ComposeSaveConflict) => void,
): () => void {
  conflictListeners.add(listener);
  return () => conflictListeners.delete(listener);
}

function notifyConflict(conflict: ComposeSaveConflict): void {
  for (const listener of conflictListeners) listener(conflict);
}
