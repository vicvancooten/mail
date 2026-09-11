import type { DocumentSave, DocumentSaveOutcome } from "@mail/shared";
import { listQueuedNoteSaves, resolveNoteSaveOutcomes, toWireNoteSave } from "../store/notes.js";
import { listQueuedTaskSaves, resolveTaskSaveOutcomes, toWireTaskSave } from "../store/tasks.js";

/**
 * The `documentSaves` channel's collection registry (#250) —
 * `collection-registry.ts`'s sibling for the save channel rather than the
 * collection-delta ones: one entry per App collection whose block-document
 * body rides this channel. `sync-round.ts` reads this array and nothing else
 * to gather the round's flush and dispatch its outcomes, so a second
 * collection (Task) joins by declaring its own entry here rather than a
 * hard-coded Note path.
 */
export interface DocumentSaveCollectionEntry {
  readonly collection: DocumentSave["collection"];
  /** This collection's queued saves, already tagged with `collection` for the wire. */
  readonly listQueued: () => Promise<DocumentSave[]>;
  /** Dequeues whatever of this collection's own queue a round trip answered for. */
  readonly resolveOutcomes: (
    queued: DocumentSave[],
    outcomes: DocumentSaveOutcome[],
  ) => Promise<void>;
}

export const DOCUMENT_SAVE_COLLECTIONS: readonly DocumentSaveCollectionEntry[] = [
  {
    collection: "Note",
    listQueued: async () => (await listQueuedNoteSaves()).map(toWireNoteSave),
    resolveOutcomes: resolveNoteSaveOutcomes,
  },
  {
    collection: "Task",
    listQueued: async () => (await listQueuedTaskSaves()).map(toWireTaskSave),
    resolveOutcomes: resolveTaskSaveOutcomes,
  },
];
