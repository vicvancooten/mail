import type { Label } from "@mail/shared";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Clock,
  Inbox,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  Reply,
  ShieldCheck,
  Tag,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { FOLDER_LABELS, FOLDER_ORDER, type FolderKey } from "./folders.js";

/**
 * The mail folder rail (#74, rebuilt against the comp in #86): a Compose
 * pill, then the fixed folder destinations in `folders.ts#FOLDER_ORDER`,
 * then the Mail Account's Labels — an independently scrolling bounded pane
 * (`mail.css`'s own `.side-nav` rule), not the thread list's own scroll
 * container.
 *
 * The comp's rail (`.side-nav` in
 * `docs/design/prototypes/the-instrument.html`) is a run of transparent
 * rounded rows on the page ground: no compartment head, no rules between
 * entries, no inverted selection — the current entry is an `--accent-soft`
 * tint with accent ink, and everything else is quiet until hovered. Each
 * entry leads with a stroke icon, because a rail of bare words gives the eye
 * nothing to aim at.
 *
 * Counts are a call to action, never decoration (the ticket's own
 * acceptance criterion): only the Screener's held count and Drafts' unsent
 * count ever render one, and only once there's something to act on — a
 * `0` renders no badge at all.
 *
 * On phone this isn't a permanent rail: it's a bottom sheet, opened from its
 * own toggle (`.side-nav-toggle`, shown only under the narrow-viewport
 * breakpoint `mail.css` already uses for Split/List). The header's hub mark
 * stays the App Switcher at every width, as the comp has it — this sheet is
 * Mail's own folder navigation, a different question.
 */

const FOLDER_ICONS: Record<FolderKey, LucideIcon> = {
  inbox: Inbox,
  screener: ShieldCheck,
  snoozed: Clock,
  pinned: Pin,
  drafts: Pencil,
  sent: Reply,
  archive: Archive,
  trash: Trash2,
};

export function Sidebar({
  folder,
  onSelectFolder,
  labels,
  labelFilter,
  onSelectLabel,
  onCompose,
  screenerCount,
  draftsCount,
}: {
  folder: FolderKey;
  onSelectFolder: (folder: FolderKey) => void;
  labels: Label[];
  labelFilter: string | null;
  onSelectLabel: (labelId: string) => void;
  onCompose: () => void;
  screenerCount: number;
  draftsCount: number;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);

  function selectFolder(next: FolderKey) {
    onSelectFolder(next);
    setSheetOpen(false);
  }

  function selectLabel(labelId: string) {
    onSelectLabel(labelId);
    setSheetOpen(false);
  }

  return (
    <>
      <button
        type="button"
        className="side-nav-toggle"
        onClick={() => setSheetOpen(true)}
        aria-label="Open folders"
        aria-expanded={sheetOpen}
      >
        <PanelLeft size={18} />
      </button>
      {sheetOpen ? (
        <div className="side-nav-scrim" onClick={() => setSheetOpen(false)} aria-hidden="true" />
      ) : null}
      <nav className={`side-nav${sheetOpen ? " open" : ""}`} aria-label="Folders">
        <button type="button" className="compose-btn" onClick={onCompose}>
          <Plus size={14} />
          Compose
        </button>
        <div className="nav-list">
          {FOLDER_ORDER.map((key) => {
            const count = key === "screener" ? screenerCount : key === "drafts" ? draftsCount : 0;
            const active = labelFilter === null && folder === key;
            const Icon = FOLDER_ICONS[key];
            return (
              <button
                key={key}
                type="button"
                className={`nav-item${active ? " active" : ""}`}
                onClick={() => selectFolder(key)}
              >
                <Icon size={15} />
                <span className="nav-label">{FOLDER_LABELS[key]}</span>
                {count > 0 ? <span className="nav-count tabular">{count}</span> : null}
              </button>
            );
          })}
        </div>
        {labels.length > 0 ? (
          <>
            <p className="nav-heading">Labels</p>
            <div className="nav-list">
              {labels.map((label) => (
                <button
                  key={label.id}
                  type="button"
                  className={`nav-item${labelFilter === label.id ? " active" : ""}`}
                  onClick={() => selectLabel(label.id)}
                >
                  <Tag size={15} />
                  <span className="nav-label">{label.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </nav>
    </>
  );
}
