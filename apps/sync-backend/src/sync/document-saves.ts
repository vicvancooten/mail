import type { DocumentSave, DocumentSaveOutcome } from "@mail/shared";
import type { Db } from "../db/client.js";
import { flushNoteSaves } from "./note-store.js";
import { flushTaskSaves } from "./task-store.js";

/**
 * The `documentSaves` channel's collection registry (#250) —
 * `collection-registry.ts`'s sibling for the save channel rather than the
 * collection-delta ones: one entry per App collection whose block-document
 * body rides this channel. `routes/sync.ts` calls `flushDocumentSaves`
 * below and nothing else, so a second collection (Task) joins by declaring
 * its own entry here rather than a hard-coded Note path.
 */
interface DocumentSaveCollectionDescriptor {
  readonly collection: DocumentSave["collection"];
  readonly flush: (db: Db, userId: string, saves: DocumentSave[]) => Promise<DocumentSaveOutcome[]>;
}

const documentSaveCollectionRegistry: readonly DocumentSaveCollectionDescriptor[] = [
  {
    collection: "Note",
    flush: (db, userId, saves) =>
      flushNoteSaves(
        db,
        userId,
        saves.filter((save) => save.collection === "Note"),
      ),
  },
  {
    collection: "Task",
    flush: (db, userId, saves) =>
      flushTaskSaves(
        db,
        userId,
        saves.filter((save) => save.collection === "Task"),
      ),
  },
];

/**
 * Applies one User's whole `documentSaves` array (#192, #250, ADR-0023),
 * dispatching each save to its own collection's flush by `collection` key —
 * the generalisation of `flushNoteSaves` being the entire flush that
 * #192 shipped. Outcomes come back in no particular cross-collection order;
 * `resolveNoteSaveOutcomes`'s (and any future collection's) own dequeue
 * matches by `id`/`saveId`, never by array position.
 */
export async function flushDocumentSaves(
  db: Db,
  userId: string,
  saves: DocumentSave[],
): Promise<DocumentSaveOutcome[]> {
  const outcomes: DocumentSaveOutcome[] = [];
  for (const descriptor of documentSaveCollectionRegistry) {
    const own = saves.filter((save) => save.collection === descriptor.collection);
    if (own.length === 0) continue;
    outcomes.push(...(await descriptor.flush(db, userId, own)));
  }
  return outcomes;
}
