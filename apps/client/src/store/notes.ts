import type { Note, NoteDocument, NoteSave, NoteSaveOutcome } from "@mail/shared";
import { EMPTY_NOTE_DOCUMENT } from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import type { PendingNoteSave } from "./db.js";
import { localCache } from "./local-cache.js";
import { labelIdForName, sessionUserId } from "./session.js";
import { generateUlid } from "./ulid.js";
import { enqueueUserMutation } from "./user-mutation-queue.js";

/**
 * A Note's Local Cache row and the `noteSaves` channel's coalescing queue
 * (#192, ADR-0023) — component-facing read and write together, `sync/`-facing
 * flush together, the same "one focused concern, one module" shape
 * `compositions.ts` uses for its own autosave queue.
 *
 * Structural actions (create, delete, label, unlabel) ride the User-scoped
 * Optimistic Action queue (`user-mutation-queue.ts`) with real inverses
 * (ADR-0019); body edits ride `pendingNoteSaves` instead, last-write-wins,
 * never rejected — see `db.ts#PendingNoteSave`'s own doc comment for why a
 * `put()` is the whole of the coalescing.
 */

/** A fresh Note id, mintable before any content exists — the same "offline-derivable address" `newCompositionId` already gives a Composition. */
export function newNoteId(): string {
  return generateUlid();
}

export function useNote(id: string | null): Note | undefined {
  return useLiveQuery(() => readNote(id), [id]);
}

export async function readNote(id: string | null): Promise<Note | undefined> {
  if (id === null) return undefined;
  return localCache().notes.get(id);
}

/** Every Note the signed-in User holds, most recently updated first, minus anything in Recently Deleted (#194) — the whole of what a minimal "demonstrate the collection" list needs; the real grid is #193's. */
export function useNotes(): Note[] | undefined {
  return useLiveQuery(() => readNotes(), []);
}

export async function readNotes(): Promise<Note[]> {
  const rows = await localCache().notes.toArray();
  return rows
    .filter((row) => row.deletedAt === null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Recently Deleted (#194): every Note this User has soft-deleted, most
 * recently deleted first — `readNotes`' own mirror image, filtering the
 * opposite way over the same `notes` table rather than a second synced
 * collection. A purged row (`sync/note-purge.ts`, 30 days on) simply stops
 * appearing here the next sync round, the same "tombstone removes the row"
 * path any other destroyed entity takes.
 */
export function useDeletedNotes(): Note[] | undefined {
  return useLiveQuery(() => readDeletedNotes(), []);
}

export async function readDeletedNotes(): Promise<Note[]> {
  const rows = await localCache().notes.toArray();
  return rows
    .filter((row): row is Note & { deletedAt: string } => row.deletedAt !== null)
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

/**
 * Creates a Note (#192): writes the durable row optimistically — empty
 * document, no Labels — and enqueues the `createNote` intent whose real
 * inverse is `deleteNote` (ADR-0019). `id` is minted by the caller
 * (`newNoteId`) before this is ever called, the same "address exists before
 * the round trip" shape `saveComposition`'s lazy row creation gives a
 * Composition, except here the structural intent — not the first body save
 * — is what the Sync Backend treats as the row's creation.
 */
export async function createNote(id: string): Promise<void> {
  const userId = sessionUserId();
  if (userId === null) return;
  const now = new Date().toISOString();
  await localCache().notes.put({
    id,
    userId,
    document: EMPTY_NOTE_DOCUMENT,
    labelIds: [],
    pinned: false,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await enqueueUserMutation({ type: "createNote", noteId: id });
}

/**
 * Deletes a Note (#192): permanent, the real inverse of `createNote`
 * (ADR-0019) — not the future soft-delete/Recently Deleted feature (#194).
 * Optimistic the same way `discardComposition` is: the local row (and
 * whatever body save was still queued for it) is gone the instant this is
 * called, not once the Sync Backend answers.
 */
export async function deleteNote(id: string): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.notes, db.pendingNoteSaves], async () => {
    await db.notes.delete(id);
    await db.pendingNoteSaves.delete(id);
  });
  await enqueueUserMutation({ type: "deleteNote", noteId: id });
}

/** Applies a Label to a Note (#192) — `applyLabel`'s shape, optimistic overlay included: the row's own `labelIds` is what every reader sees, no separate overlay table. */
export async function labelNote(id: string, name: string): Promise<void> {
  await enqueueUserMutation({ type: "labelNote", noteId: id, name });
  await addLabelLocally(id, name);
}

/** Removes a Label from a Note (#192) — `removeLabel`'s shape; see `labelNote` above. */
export async function unlabelNote(id: string, name: string): Promise<void> {
  await enqueueUserMutation({ type: "unlabelNote", noteId: id, name });
  await removeLabelLocally(id, name);
}

/** Pins a Note (#193) — the grid's Pinned/Others split, `labelNote`'s shape: a real inverse (`unpinNote`), optimistic overlay on the row itself, no separate overlay table. */
export async function pinNote(id: string): Promise<void> {
  await enqueueUserMutation({ type: "pinNote", noteId: id });
  await setPinnedLocally(id, true);
}

/** Unpins a Note, the real inverse of `pinNote`. */
export async function unpinNote(id: string): Promise<void> {
  await enqueueUserMutation({ type: "unpinNote", noteId: id });
  await setPinnedLocally(id, false);
}

async function setPinnedLocally(id: string, pinned: boolean): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.notes, async () => {
    const row = await db.notes.get(id);
    if (!row || row.pinned === pinned) return;
    await db.notes.put({ ...row, pinned });
  });
}

/**
 * Soft-deletes a Note (#194): an Optimistic Action whose real inverse is
 * `restoreNote` (ADR-0019), the same `pinNote`/`unpinNote` shape — only
 * `deletedAt` flips, the row itself (and its Labels and `pinned` state)
 * stays exactly as it was, which is what makes `restoreNote` an exact
 * restore rather than a re-creation (a Note has no upstream to re-derive
 * from). Callers raise the Undo toast themselves right after this resolves
 * (`notes/NotesGrid.tsx`, `notes/NoteDialog.tsx`), the same split
 * `useTriage.ts`'s own trash/archive calls draw between the store write and
 * the toast.
 */
export async function trashNote(id: string): Promise<void> {
  await enqueueUserMutation({ type: "trashNote", noteId: id });
  await setDeletedLocally(id, new Date().toISOString());
}

/** Restores a Note out of Recently Deleted, the real inverse of `trashNote`. */
export async function restoreNote(id: string): Promise<void> {
  await enqueueUserMutation({ type: "restoreNote", noteId: id });
  await setDeletedLocally(id, null);
}

async function setDeletedLocally(id: string, deletedAt: string | null): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.notes, async () => {
    const row = await db.notes.get(id);
    if (!row || row.deletedAt === deletedAt) return;
    await db.notes.put({ ...row, deletedAt });
  });
}

/** `session.ts#labelIdForName` is the Client's one place that derives `Label.id` from a name — reused here so a Note's optimistic overlay can never disagree with a Thread's. */
async function addLabelLocally(id: string, name: string): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.notes, async () => {
    const row = await db.notes.get(id);
    const labelId = labelIdForName(name);
    if (!row || labelId === null || row.labelIds.includes(labelId)) return;
    await db.notes.put({ ...row, labelIds: [...row.labelIds, labelId] });
  });
}

async function removeLabelLocally(id: string, name: string): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.notes, async () => {
    const row = await db.notes.get(id);
    const labelId = labelIdForName(name);
    if (!row || labelId === null) return;
    await db.notes.put({ ...row, labelIds: row.labelIds.filter((entry) => entry !== labelId) });
  });
}

/**
 * Writes one body autosave (#192, ADR-0023) — the `noteSaves` channel's
 * write side, `saveComposition`'s sibling: the durable row and the
 * coalescing queue are written in one transaction, so a reload between them
 * can never observe one without the other. Coalescing is `pendingNoteSaves
 * .put()`'s own upsert semantics: a second call for the same `id` before the
 * first has flushed simply overwrites the queued row.
 *
 * Created lazily if somehow missing (ADR-0012's own phrase for a
 * Composition), the same tolerance `note-store.ts#applyOne` gives this same
 * race server-side — `createNote` is what normally creates the row, milliseconds
 * before the first keystroke ever reaches here, but nothing requires that
 * order, and a save must never silently no-op the local row while still
 * queuing itself to flush.
 */
export async function saveNoteBody(id: string, document: NoteDocument): Promise<void> {
  const db = localCache();
  const now = new Date().toISOString();
  await db.transaction("rw", [db.notes, db.pendingNoteSaves], async () => {
    const existing = await db.notes.get(id);
    const userId = existing?.userId ?? sessionUserId();
    if (userId !== null) {
      await db.notes.put({
        id,
        userId,
        document,
        labelIds: existing?.labelIds ?? [],
        pinned: existing?.pinned ?? false,
        deletedAt: existing?.deletedAt ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }
    await db.pendingNoteSaves.put({ noteId: id, saveId: generateUlid(), document, queuedAt: now });
  });
}

/** Every queued body autosave, at most one per Note. */
export async function listQueuedNoteSaves(): Promise<PendingNoteSave[]> {
  return localCache().pendingNoteSaves.toArray();
}

export function toWireNoteSave(pending: PendingNoteSave): NoteSave {
  return { id: pending.noteId, saveId: pending.saveId, document: pending.document };
}

/**
 * Dequeues every body save a round trip answered for. A queued row is only
 * dequeued when its own `saveId` still matches the outcome's — a newer,
 * already-coalesced save overwrote it mid-flight, and that save is what
 * flushes next, never this stale outcome's (`resolveComposeSaveOutcomes`'s
 * own doc comment gives the same reasoning). Every outcome is `applied`
 * (`@mail/shared#noteSaveOutcomeSchema`'s own doc comment) — there is no
 * conflict branch to react to here.
 */
export async function resolveNoteSaveOutcomes(
  queued: NoteSave[],
  outcomes: NoteSaveOutcome[],
): Promise<void> {
  const ids = new Set(queued.map((save) => save.id));
  const db = localCache();
  for (const outcome of outcomes) {
    if (!ids.has(outcome.id)) continue;
    await db.transaction("rw", db.pendingNoteSaves, async () => {
      const stillQueued = await db.pendingNoteSaves.get(outcome.id);
      if (!stillQueued || stillQueued.saveId !== outcome.saveId) return;
      await db.pendingNoteSaves.delete(outcome.id);
    });
  }
}
