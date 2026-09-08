import type { Label, Note } from "@mail/shared";
import { Link } from "@tanstack/react-router";
import { Pin, Trash2 } from "lucide-react";
import { labelNameForId } from "../store/session.js";
import { NoteEditor } from "./NoteEditor.js";
import { deriveNoteTitle, notePreviewBlocks } from "./note-text.js";

/**
 * One card in the grid (#193): a `Link` to `/notes/:noteId` (opening the
 * dialog is entirely the router's job, per `NotesRoute.tsx`'s own doc
 * comment) wrapping the derived title and a read-only preview, plus the
 * Pin toggle, Delete (#194) and Label badges as siblings of that link
 * rather than nested inside it — an interactive `<button>` inside an `<a>`
 * is invalid HTML, and `ThreadRow.tsx`'s own row/action split already draws
 * this line the same way.
 */
export function NoteCard({
  note,
  labels,
  onTogglePin,
  onDelete,
}: {
  note: Note;
  /** The User's known Labels, resolved to display names — may not include one just applied offline (`labelNameForId`'s own fallback covers that). */
  labels: Label[];
  onTogglePin: () => void;
  /** Soft-deletes the Note (#194) — the caller (`NotesGrid.tsx`) owns raising the Undo toast, this control only fires the intent. */
  onDelete: () => void;
}) {
  const title = deriveNoteTitle(note.document);
  const knownNames = new Map(labels.map((label) => [label.id, label.name]));

  return (
    <div className="note-card">
      <Link
        to="/notes/$noteId"
        params={{ noteId: note.id }}
        className="note-card-link"
        aria-label={title}
      >
        <h3 className="note-card-title">{title}</h3>
        {/* The preview is a second, non-interactive copy of the same read-only
            editor a screen reader has no reason to walk block by block —
            the card's own accessible name (above) already carries the title. */}
        <div className="note-card-preview" aria-hidden="true">
          <NoteEditor document={notePreviewBlocks(note.document)} editable={false} />
        </div>
      </Link>
      <button
        type="button"
        className={`note-card-pin${note.pinned ? " pinned" : ""}`}
        aria-pressed={note.pinned}
        aria-label={note.pinned ? `Unpin "${title}"` : `Pin "${title}"`}
        onClick={(event) => {
          // A sibling of the `Link` above, not a child of it — no navigation
          // to stop, but the row-hover styling both share means this still
          // needs its own explicit target rather than any ambient click.
          event.preventDefault();
          onTogglePin();
        }}
      >
        <Pin size={14} />
      </button>
      <button
        type="button"
        className="note-card-delete"
        aria-label={`Delete "${title}"`}
        onClick={(event) => {
          event.preventDefault();
          onDelete();
        }}
      >
        <Trash2 size={14} />
      </button>
      {note.labelIds.length > 0 ? (
        <ul className="note-card-labels">
          {note.labelIds.map((id) => (
            <li key={id} className="note-card-label-badge">
              {knownNames.get(id) ?? labelNameForId(id)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
