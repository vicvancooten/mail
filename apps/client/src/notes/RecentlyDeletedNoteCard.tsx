import type { Note } from "@mail/shared";
import { NoteEditor } from "./NoteEditor.js";
import { deriveNoteTitle, notePreviewBlocks } from "./note-text.js";

/**
 * One card in Recently Deleted (#194's own words: "a view of the Notes App
 * listing the same cards greyed, each with a Restore control"). Deliberately
 * not `NoteCard` with a prop bag of overrides: there is no `Link` into the
 * dialog here (a deleted Note reads, it isn't edited from this screen) and
 * no Pin toggle — the two controls this card actually needs (the title/
 * preview read and Restore) are different enough from the grid's own card
 * that sharing one component would mean more conditionals than markup.
 */
export function RecentlyDeletedNoteCard({
  note,
  onRestore,
}: {
  note: Note;
  onRestore: () => void;
}) {
  const title = deriveNoteTitle(note.document);

  return (
    <div className="note-card note-card-deleted">
      <div className="note-card-link" aria-hidden="true">
        <h3 className="note-card-title">{title}</h3>
        <div className="note-card-preview">
          <NoteEditor document={notePreviewBlocks(note.document)} editable={false} />
        </div>
      </div>
      <button type="button" className="note-card-restore" onClick={onRestore}>
        Restore "{title}"
      </button>
    </div>
  );
}
