import { Link } from "@tanstack/react-router";
import { restoreNote, useDeletedNotes } from "../store/index.js";
import "./notes.css";
import { RecentlyDeletedNoteCard } from "./RecentlyDeletedNoteCard.js";

/**
 * Recently Deleted (#194): its own screen at `/notes/recently-deleted`
 * (`router/routes.tsx#notesRecentlyDeletedRoute`), not an overlay over the
 * grid the way the edit dialog is — a deleted Note isn't edited from here,
 * so there is nothing underneath worth keeping visible. `useDeletedNotes`
 * already hands back the right sort (`store/notes.ts#readDeletedNotes`'s
 * own doc comment); this only lays the cards out, the same "filter, don't
 * re-sort" division `NotesGrid.tsx` draws for the ordinary grid.
 */
export function NotesRecentlyDeleted() {
  const notes = useDeletedNotes();

  return (
    <section className="notes-grid-section" aria-label="Recently Deleted">
      <div className="notes-recently-deleted-header">
        <Link to="/notes" className="notes-recently-deleted-back">
          ← Notes
        </Link>
        <h2 className="notes-grid-heading">Recently Deleted</h2>
      </div>
      {notes && notes.length === 0 ? (
        <p className="notes-grid-empty">Nothing here.</p>
      ) : (
        <div className="notes-grid">
          {(notes ?? []).map((note) => (
            <RecentlyDeletedNoteCard
              key={note.id}
              note={note}
              onRestore={() => void restoreNote(note.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
