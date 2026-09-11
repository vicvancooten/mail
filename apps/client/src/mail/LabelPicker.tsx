import type { Label } from "@mail/shared";
import { Check, Tag } from "lucide-react";
import { useState } from "react";
import { labelNameForId } from "../store/index.js";

/**
 * The minimum shape `LabelPicker` actually reads off its `thread` prop —
 * `CachedThread` satisfies this structurally, and so does a bare `Task`
 * (#253's own reuse, `tasks/TaskEditor.tsx`), with no adapter object beyond
 * this narrower type.
 */
export interface LabelPickerEntity {
  id: string;
  labelIds: readonly string[];
}

/** The minimum shape `LabelPicker` needs to apply/remove a Label — `Triage` satisfies this structurally (`applyLabel`/`removeLabel`), and so does a small Task-scoped adapter (#253's own reuse). */
export interface LabelPickerActions {
  applyLabel(id: string, name: string): void;
  removeLabel(id: string, name: string): void;
}

/**
 * The apply/remove side of Label (#43): a small popover listing the User's
 * existing Labels as toggles (#186 — one set across every Mail Account),
 * plus a text field for a brand-new
 * name. No management UI, colors, or nesting (poc-scope.md) — this is the
 * whole of Label's UI surface. Opened from `ThreadDetailPane` (mouse click
 * or the `L` key), closed on Escape or clicking its own toggle again — and,
 * unchanged, from `tasks/TaskEditor.tsx` (#253) over a Task instead of a
 * Thread, which is what narrowed `thread`/`triage` below to the structural
 * shape this component actually reads rather than `CachedThread`/`Triage`
 * by name.
 *
 * A Label a Thread already carries but that hasn't synced back into the
 * `Label` collection yet (a brand-new name, applied offline) still renders
 * correctly: `labelNameForId` recovers the display name straight from the
 * id, no round trip required.
 */
export function LabelPicker({
  thread,
  labels,
  triage,
  onClose,
}: {
  thread: LabelPickerEntity;
  /** The User's known Labels (#43's `Label` collection, User-scoped since #186) — may not include one just applied offline. */
  labels: Label[];
  triage: LabelPickerActions;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");

  const known = new Map(labels.map((label) => [label.id, label.name]));
  // Anything the Thread already carries that `labels` doesn't know the name
  // of yet (offline-applied, not synced back) still gets a chip, via the
  // deterministic id → name fallback.
  for (const id of thread.labelIds) {
    if (!known.has(id)) known.set(id, labelNameForId(id));
  }
  const entries = [...known.entries()].sort((left, right) => left[1].localeCompare(right[1]));

  function submitDraft() {
    const name = draft.trim();
    if (name) triage.applyLabel(thread.id, name);
    setDraft("");
  }

  return (
    <div className="label-picker" role="menu">
      {entries.length > 0 ? (
        <ul className="label-picker-list">
          {entries.map(([id, name]) => {
            const applied = thread.labelIds.includes(id);
            return (
              <li key={id}>
                <button
                  type="button"
                  className={`label-toggle${applied ? " on" : ""}`}
                  onClick={() =>
                    applied
                      ? triage.removeLabel(thread.id, name)
                      : triage.applyLabel(thread.id, name)
                  }
                  role="menuitemcheckbox"
                  aria-checked={applied}
                >
                  {applied ? <Check size={12} /> : <Tag size={12} />}
                  {name}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="label-picker-empty">No labels yet.</p>
      )}
      <form
        className="label-picker-new"
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="New label…"
          maxLength={64}
          aria-label="New label name"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onClose();
            }
          }}
        />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}
