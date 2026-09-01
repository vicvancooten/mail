import type { Label } from "@mail/shared";
import { labelNameFromId } from "@mail/shared";
import { Check, Tag } from "lucide-react";
import { useState } from "react";
import type { CachedThread } from "../store/index.js";
import type { Triage } from "./useTriage.js";

/**
 * The apply/remove side of Label (#43): a small popover listing the Mail
 * Account's existing Labels as toggles, plus a text field for a brand-new
 * name. No management UI, colors, or nesting (poc-scope.md) — this is the
 * whole of Label's UI surface. Opened from `ThreadDetailPane` (mouse click
 * or the `L` key), closed on Escape or clicking its own toggle again.
 *
 * A Label a Thread already carries but that hasn't synced back into the
 * `Label` collection yet (a brand-new name, applied offline) still renders
 * correctly: `labelNameFromId` recovers the display name straight from the
 * id, no round trip required.
 */
export function LabelPicker({
  thread,
  labels,
  triage,
  onClose,
}: {
  thread: CachedThread;
  /** The Mail Account's known Labels (#43's `Label` collection) — may not include one just applied offline. */
  labels: Label[];
  triage: Triage;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");

  const known = new Map(labels.map((label) => [label.id, label.name]));
  // Anything the Thread already carries that `labels` doesn't know the name
  // of yet (offline-applied, not synced back) still gets a chip, via the
  // deterministic id → name fallback.
  for (const id of thread.labelIds) {
    if (!known.has(id)) known.set(id, labelNameFromId(thread.mailAccountId, id));
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
