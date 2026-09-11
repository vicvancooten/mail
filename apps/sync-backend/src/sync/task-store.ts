import type { DocumentSave, DocumentSaveOutcome } from "@mail/shared";
import { EMPTY_NOTE_DOCUMENT } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { tasks } from "../db/schema.js";

/** This module's own slice of the `documentSaves` channel's union — every save `document-saves.ts` routes here is already known to carry this collection's key. */
type TaskSave = Extract<DocumentSave, { collection: "Task" }>;

/** The initial document `createTask` (`sync/mutations.ts`) seeds a brand-new row with — the same empty BlockNote document a Note opens with (ADR-0024, `tasks.ts#taskSchema`'s own doc comment). */
export const INITIAL_TASK_DOCUMENT = EMPTY_NOTE_DOCUMENT;

/**
 * Applies one User's queued Task body autosaves (#251, #250, ADR-0023) —
 * `note-store.ts#flushNoteSaves`'s sibling on the `documentSaves` channel,
 * same "never rejects a document write" contract, same idempotent-by-retry
 * unconditional upsert.
 *
 * **Not** lazily created here, unlike a Note: `createTask`
 * (`sync/mutations.ts`) is what inserts this row, and it needs
 * `taskListId`/`title` a body save simply does not carry — there is no
 * sensible row to lazily create from a save alone. A save that raced a
 * not-yet-applied `createTask` (the two channels are separate arrays on the
 * same `POST /sync` request, so nothing orders them) is silently dropped
 * instead: still reported `applied` (the channel's own "never rejects"
 * contract is about the wire outcome, not a promise that every save lands
 * on a row), and the very next autosave a few hundred ms later
 * (`use-note-autosave.ts`'s own debounce) lands normally once `createTask`
 * has caught up.
 */
export async function flushTaskSaves(
  db: Db,
  userId: string,
  saves: TaskSave[],
): Promise<DocumentSaveOutcome[]> {
  const outcomes: DocumentSaveOutcome[] = [];
  for (const save of saves) {
    outcomes.push(await applyOne(db, userId, save));
  }
  return outcomes;
}

async function applyOne(db: Db, userId: string, save: TaskSave): Promise<DocumentSaveOutcome> {
  const [existing] = await db
    .select({ userId: tasks.userId })
    .from(tasks)
    .where(eq(tasks.id, save.id))
    .limit(1);

  if (existing && existing.userId === userId) {
    await db
      .update(tasks)
      .set({ document: save.document, updatedAt: new Date() })
      .where(eq(tasks.id, save.id));
  }

  return { collection: "Task", id: save.id, saveId: save.saveId, status: "applied" };
}
