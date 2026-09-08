import { Pin, Trash2 } from "lucide-react";
import { useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog.js";
import { announceUndoableAction } from "../mail/undo-toast.js";
import { pinNote, restoreNote, trashNote, unpinNote, useNote } from "../store/index.js";
import { NoteEditor } from "./NoteEditor.js";
import { deriveNoteTitle } from "./note-text.js";
import "./notes.css";
import { useNoteAutosave } from "./use-note-autosave.js";

/**
 * Editing is a dialog over the grid, Notion-style rather than a page
 * navigation (#193's own words): the existing shadcn `Dialog`
 * (`components/ui/dialog.js`, `ScreenerViewDialog.tsx`'s own "full shadcn
 * for every floating primitive" precedent), sized close to full-height over
 * a dimmed grid — no new overlay primitive.
 *
 * This component is always open (`open` is a literal `true`) — the caller
 * (`router/NoteDialogRoute.tsx`) only ever mounts it because `/notes/:noteId`
 * matched, so the dialog's open/closed state *is* the router's match, per
 * the ticket's own framing; there is no local state here that could
 * disagree with the URL. Esc, the close control and a backdrop click all
 * reach `onOpenChange(false)` through Radix's own handling — one prop
 * covers every one of the ticket's three close paths, none of them wired by
 * hand here.
 *
 * There is no "done editing" step: edits save continuously through the
 * `noteSaves` channel (#192) via `useNoteAutosave`, and `flush()` on close
 * (this file's own call) only shortens the window a keystroke could
 * otherwise wait out the 400ms debounce before this dialog unmounts.
 */
export function NoteDialog({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const note = useNote(noteId);
  const autosave = useNoteAutosave(noteId);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) return;
      autosave.flush();
      onClose();
    },
    [autosave, onClose],
  );

  const togglePin = useCallback(() => {
    if (!note) return;
    void (note.pinned ? unpinNote(note.id) : pinNote(note.id));
  }, [note]);

  /**
   * Delete (#194): fires the same Optimistic Action + Undo toast
   * `NotesGrid.tsx`'s own card control does — closing the dialog itself is
   * not this handler's job, the `deletedAt` effect below is, so a delete
   * that arrives from the *other* Client while this dialog is open closes
   * it the same way.
   */
  const handleDelete = useCallback(() => {
    if (!note) return;
    void trashNote(note.id);
    announceUndoableAction("noteDelete", () => void restoreNote(note.id));
  }, [note]);

  // "Deleting the Note open in the dialog closes it and navigates back to
  // `/notes`" (#194's own acceptance line) — driven by the row's own
  // `deletedAt`, not the button above, so it covers a delete from the grid
  // behind this same dialog and a delete that lands from a second Client
  // mid-sync just as well as this dialog's own button.
  useEffect(() => {
    if (note?.deletedAt) onClose();
  }, [note?.deletedAt, onClose]);

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="note-dialog">
        {note ? (
          <>
            {/* No visible title bar over the editor (the ticket names none) — an
                accessible name is still owed to the dialog itself. */}
            <DialogTitle className="sr-only">{deriveNoteTitle(note.document)}</DialogTitle>
            <button
              type="button"
              className={`note-dialog-pin${note.pinned ? " pinned" : ""}`}
              aria-pressed={note.pinned}
              aria-label={note.pinned ? "Unpin note" : "Pin note"}
              onClick={togglePin}
            >
              <Pin size={16} />
            </button>
            <button
              type="button"
              className="note-dialog-delete"
              aria-label="Delete note"
              onClick={handleDelete}
            >
              <Trash2 size={16} />
            </button>
            <NoteEditor
              document={note.document}
              onChange={autosave.onChange}
              className="note-dialog-editor"
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
