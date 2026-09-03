import type { Label } from "@mail/shared";
import { useState } from "react";
import { Pictogram } from "../brand/Pictogram.js";
import { FOLDER_LABELS, FOLDER_ORDER, type FolderKey } from "./folders.js";

/**
 * The mail folder sidebar (#74): Compose, the fixed folder destinations in
 * `folders.ts#FOLDER_ORDER`, then the Mail Account's Labels — an
 * independently scrolling bounded pane (`mail.css`'s own `.mail-sidebar`
 * rule), not the thread list's own scroll container.
 *
 * Counts are a call to action, never decoration (the ticket's own
 * acceptance criterion): only the Screener's held count and Drafts' unsent
 * count ever render one, and only once there's something to act on — a
 * `0` renders no badge at all.
 *
 * On phone this isn't a permanent rail: it's a bottom sheet, opened from its
 * own toggle (`.mail-sidebar-toggle`, shown only under the narrow-viewport
 * breakpoint `mail.css` already uses for Split/List) rather than the
 * header's hub mark — the App Switcher that mark opens is #72's own ticket,
 * landing in `router/RootLayout.tsx`; wiring the mark itself to this sheet
 * is a follow-up once that lands.
 */
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
        className="mail-sidebar-toggle"
        onClick={() => setSheetOpen(true)}
        aria-label="Open folders"
        aria-expanded={sheetOpen}
      >
        <Pictogram name="frame" size={18} />
      </button>
      {sheetOpen ? (
        <div
          className="mail-sidebar-scrim"
          onClick={() => setSheetOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      <nav className={`mail-sidebar${sheetOpen ? " open" : ""}`} aria-label="Folders">
        <button type="button" className="mail-sidebar-compose" onClick={onCompose}>
          <Pictogram name="compose" size={16} />
          Compose
        </button>
        <ul className="mail-sidebar-folders">
          {FOLDER_ORDER.map((key) => {
            const count = key === "screener" ? screenerCount : key === "drafts" ? draftsCount : 0;
            const active = labelFilter === null && folder === key;
            return (
              <li key={key}>
                <button
                  type="button"
                  className="mail-sidebar-item"
                  data-active={active}
                  onClick={() => selectFolder(key)}
                >
                  <span>{FOLDER_LABELS[key]}</span>
                  {count > 0 ? <span className="mail-sidebar-count">{count}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
        {labels.length > 0 ? (
          <>
            <p className="mail-sidebar-heading">Labels</p>
            <ul className="mail-sidebar-labels">
              {labels.map((label) => (
                <li key={label.id}>
                  <button
                    type="button"
                    className="mail-sidebar-item"
                    data-active={labelFilter === label.id}
                    onClick={() => selectLabel(label.id)}
                  >
                    {label.name}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </nav>
    </>
  );
}
