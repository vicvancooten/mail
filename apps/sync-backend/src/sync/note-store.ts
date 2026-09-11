import type { DocumentSave, DocumentSaveOutcome } from "@mail/shared";
import { EMPTY_NOTE_DOCUMENT } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { notes } from "../db/schema.js";

/** This module's own slice of the `documentSaves` channel's union — every save `document-saves.ts` routes here is already known to carry this collection's key. */
type NoteSave = Extract<DocumentSave, { collection: "Note" }>;

/**
 * Applies one User's queued Note body autosaves (#192, #250, ADR-0023) — the
 * `documentSaves` channel's `Note` entry (`document-saves.ts`'s registry),
 * `compose-store.ts#flushComposeSaves`'s sibling and deliberately simpler:
 * `saves` carries at most one entry per Note (the Client's own coalescing
 * queue, `store/notes.ts`, never holds more than that), and — unlike a
 * Composition save — there is no version to check and no ledger to replay
 * against.
 *
 * A retried `saveId` (a dropped response over a flaky connection) simply
 * writes the same `document` again: idempotent by construction, since this
 * is an unconditional last-write-wins upsert rather than a version-checked
 * transition with a `conflict`/`rejected` branch worth remembering. That is
 * the whole of what "never rejects a document write" (ADR-0023) buys here —
 * no `note_save_ledger` table, no race to reconcile.
 */
export async function flushNoteSaves(
  db: Db,
  userId: string,
  saves: NoteSave[],
): Promise<DocumentSaveOutcome[]> {
  const outcomes: DocumentSaveOutcome[] = [];
  for (const save of saves) {
    outcomes.push(await applyOne(db, userId, save));
  }
  return outcomes;
}

/**
 * Upserts a Note's `document` by id. The row usually already exists — a
 * `createNote` intent (`sync/mutations.ts`) creates it before any save can
 * be typed for it — but this **creates it lazily** (ADR-0012's own phrase
 * for `Composition`) rather than rejecting a save that raced a not-yet-applied
 * `createNote`: the `documentSaves` channel and the User-scoped mutation queue
 * are two separate arrays on the same `POST /sync` request, so nothing
 * promises `createNote` is applied before this runs. Lazily creating is what
 * makes that ordering harmless either way, the same "never a user-visible
 * error" posture ADR-0023 asks for.
 *
 * A row that belongs to a *different* User (only reachable if two Clients
 * somehow minted the same ULID, astronomically unlikely) is left untouched
 * rather than overwritten — the one guard this function keeps despite
 * "never rejects", since silently handing one User's Note id to another's
 * content is not the kind of write ADR-0023 is describing.
 */
async function applyOne(db: Db, userId: string, save: NoteSave): Promise<DocumentSaveOutcome> {
  const [existing] = await db
    .select({ userId: notes.userId })
    .from(notes)
    .where(eq(notes.id, save.id))
    .limit(1);

  if (!existing) {
    await db.insert(notes).values({
      id: save.id,
      userId,
      document: save.document,
      labelIds: [],
    });
  } else if (existing.userId === userId) {
    await db
      .update(notes)
      .set({ document: save.document, updatedAt: new Date() })
      .where(eq(notes.id, save.id));
  }

  return { collection: "Note", id: save.id, saveId: save.saveId, status: "applied" };
}

/** The initial document `createNote` (`sync/mutations.ts`) seeds a brand-new row with, before the first body save ever lands. */
export const INITIAL_NOTE_DOCUMENT = EMPTY_NOTE_DOCUMENT;
