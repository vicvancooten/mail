import { X } from "lucide-react";
import { useEffect } from "react";
import type { Triage } from "../useTriage.js";
import { buildCommands, COMMAND_SECTIONS } from "./commands.js";

/** Every `Triage` method as a no-op — the Shortcut Sheet only ever reads
 * `buildCommands`' `label`/`section`/`shortcut`, never calls `run`, so this
 * exists purely to satisfy `CommandContext`'s shape with no live Thread. */
const NOOP_TRIAGE: Triage = {
  archive: () => {},
  trash: () => {},
  snooze: () => {},
  toggleStar: () => {},
  toggleRead: () => {},
  togglePin: () => {},
  applyLabel: () => {},
  removeLabel: () => {},
};

/**
 * `?` (#79): the traditional keyboard cheat sheet, grouped by section — the
 * same registry the Command Palette lists (`buildCommands`), so this can
 * never drift from what `⌘K` actually shows or from what the individual
 * `useTriage.ts`/`ThreadDetailPane.tsx`/`useComposeShortcut.ts` listeners
 * actually bind. Read-only: no `run` is ever called from here, which is why
 * it's built against a Thread-less, all-no-op context — every row's
 * `shortcut` and `label` are the same regardless of what's currently open.
 */
export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const commands = buildCommands({
    selectedThread: null,
    triage: NOOP_TRIAGE,
    latestMessage: null,
    onReply: () => {},
    onCompose: () => {},
    onBackToList: () => {},
    onOpenScreener: () => {},
    screenerCount: 0,
    onFocusSearch: () => {},
    onOpenShortcutSheet: () => {},
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-dismiss is a mouse convenience layered on an already-accessible dialog — Escape and the Close button (both real, focusable controls below) are the keyboard/screen-reader paths.
    <div
      className="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <div className="shortcut-sheet-header">
          <h2>Keyboard shortcuts</h2>
          <button
            type="button"
            className="command-palette-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>
        <div className="shortcut-sheet-body">
          {COMMAND_SECTIONS.map((section) => {
            const inSection = commands.filter((command) => command.section === section);
            if (inSection.length === 0) return null;
            return (
              <div key={section} className="shortcut-sheet-section">
                <p className="shortcut-sheet-section-label">{section}</p>
                <dl>
                  {inSection.map((command) => (
                    <div key={command.id} className="shortcut-sheet-row">
                      <dt>{command.label}</dt>
                      <dd>
                        {command.shortcut ? (
                          <kbd className="keycap">{command.shortcut}</kbd>
                        ) : (
                          <span className="command-palette-unbound">Command Palette only</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
