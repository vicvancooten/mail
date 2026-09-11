import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
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
 *
 * A shadcn `Dialog` (#281 — was its own hand-rolled backdrop + `keydown`
 * listener): outside click and Escape are Radix's, not this component's own.
 */
export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ctx = noopActionContext();
  const actions = globalActions();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="shortcut-sheet p-0" aria-label="Keyboard shortcuts">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription className="sr-only">
            Every keyboard shortcut available in the app, grouped by section.
          </DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  );
}
