import type { Label } from "@mail/shared";

/**
 * The grid's filter row (#193): multi-select Label chips, OR semantics —
 * two chips selected shows a Note carrying *either*, narrowing both the
 * Pinned and the Others section at once. Deliberately not a second search
 * field: Notes' own text search is the Command Palette's local-hit path,
 * its own later slice (#196).
 */
export function NotesLabelFilter({
  labels,
  selectedLabelIds,
  onToggle,
}: {
  labels: readonly Label[];
  selectedLabelIds: ReadonlySet<string>;
  onToggle: (labelId: string) => void;
}) {
  if (labels.length === 0) return null;

  const sorted = [...labels].sort((left, right) => left.name.localeCompare(right.name));

  return (
    <fieldset className="notes-label-filter" aria-label="Filter Notes by label">
      {sorted.map((label) => {
        const selected = selectedLabelIds.has(label.id);
        return (
          <button
            key={label.id}
            type="button"
            className={`notes-label-chip${selected ? " selected" : ""}`}
            aria-pressed={selected}
            onClick={() => onToggle(label.id)}
          >
            {label.name}
          </button>
        );
      })}
    </fieldset>
  );
}
