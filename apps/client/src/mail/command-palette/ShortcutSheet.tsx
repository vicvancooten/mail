import { X } from "lucide-react";
import { useEffect } from "react";
import { globalActions } from "../actions/registry.js";
import { ACTION_SECTIONS, actionLabel, noopActionContext } from "../actions/types.js";

/**
 * `?` (#79): the traditional keyboard cheat sheet, grouped by section —
 * straight off the Action registry (#94), the same list the Command Palette
 * shows and the same list the single `keydown` listener binds, so this can
 * never drift from what the keyboard actually does. Read-only: no action is
 * ever run from here, which is why it reads the registry against a
 * Thread-less, all-no-op context — every row's `label` and `binding` is the
 * same regardless of what happens to be open.
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

  const ctx = noopActionContext();
  const actions = globalActions();

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
          {ACTION_SECTIONS.map((section) => {
            const inSection = actions.filter((action) => action.section === section);
            if (inSection.length === 0) return null;
            return (
              <div key={section} className="shortcut-sheet-section">
                <p className="shortcut-sheet-section-label">{section}</p>
                <dl>
                  {inSection.map((action) => (
                    <div key={action.id} className="shortcut-sheet-row">
                      <dt>{actionLabel(action, ctx)}</dt>
                      <dd>
                        {action.binding ? (
                          <kbd className="keycap">{action.binding.display}</kbd>
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
