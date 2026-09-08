import type { Label, Note } from "@mail/shared";
import { useMemo, useState } from "react";
import { pinNote, unpinNote, useLabels, useNotes } from "../store/index.js";
import { useLocalCacheSync } from "../sync/use-local-cache-sync.js";
import { NoteCard } from "./NoteCard.js";
import "./notes.css";
import { NotesLabelFilter } from "./NotesLabelFilter.js";

/**
 * `/notes`'s own content (#193): a Keep-style grid, Pinned then Others, each
 * sorted last-edited descending — `useNotes()` already hands back that sort
 * (`store/notes.ts#readNotes`'s own doc comment), so this only partitions the
 * already-sorted array, the same "filter, don't re-sort" shape
 * `store/reads.ts#readThreadWindowUnsliced` gives Mail's own Pinned view.
 *
 * `useLocalCacheSync()` is called here, not assumed from an ancestor: Notes
 * is a top-level routed screen exactly like `MailSection`/`StreamStack`, each
 * of which opens the Local Cache and starts the sync loop themselves — a
 * User who lands straight on `/notes` without ever visiting `/mail` still
 * needs both to have happened.
 */
export function NotesGrid() {
  useLocalCacheSync();
  const notes = useNotes();
  const labels = useLabels();
  const [selectedLabelIds, setSelectedLabelIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const toggleLabel = (labelId: string) => {
    setSelectedLabelIds((current) => {
      const next = new Set(current);
      if (next.has(labelId)) next.delete(labelId);
      else next.add(labelId);
      return next;
    });
  };

  const filtered = useMemo(() => {
    if (!notes) return undefined;
    if (selectedLabelIds.size === 0) return notes;
    // OR semantics (#193's own acceptance line): a Note carrying *any* of
    // the selected Labels stays in, not every one of them.
    return notes.filter((note) => note.labelIds.some((id) => selectedLabelIds.has(id)));
  }, [notes, selectedLabelIds]);

  function togglePin(note: Note) {
    void (note.pinned ? unpinNote(note.id) : pinNote(note.id));
  }

  const pinned = filtered?.filter((note) => note.pinned) ?? [];
  // Only rendered once there's a Pinned section to distinguish it from —
  // a lone "Others" heading over every Note would say nothing a bare grid
  // doesn't already.
  const others = filtered?.filter((note) => !note.pinned) ?? [];

  return (
    <section className="notes-grid-section" aria-label="Notes">
      <NotesLabelFilter
        labels={labels ?? []}
        selectedLabelIds={selectedLabelIds}
        onToggle={toggleLabel}
      />
      {filtered && filtered.length === 0 ? (
        <p className="notes-grid-empty">
          {selectedLabelIds.size > 0
            ? "No Notes carry any of the selected labels."
            : "No Notes yet."}
        </p>
      ) : (
        <>
          {pinned.length > 0 ? (
            <div className="notes-grid-group">
              <h2 className="notes-grid-heading">Pinned</h2>
              <NoteCardGrid notes={pinned} labels={labels ?? []} onTogglePin={togglePin} />
            </div>
          ) : null}
          {others.length > 0 ? (
            <div className="notes-grid-group">
              {pinned.length > 0 ? <h2 className="notes-grid-heading">Others</h2> : null}
              <NoteCardGrid notes={others} labels={labels ?? []} onTogglePin={togglePin} />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function NoteCardGrid({
  notes,
  labels,
  onTogglePin,
}: {
  notes: readonly Note[];
  labels: Label[];
  onTogglePin: (note: Note) => void;
}) {
  return (
    <div className="notes-grid">
      {notes.map((note) => (
        <NoteCard key={note.id} note={note} labels={labels} onTogglePin={() => onTogglePin(note)} />
      ))}
    </div>
  );
}
