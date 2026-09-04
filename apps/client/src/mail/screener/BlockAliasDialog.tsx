import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import type { ScreenerSenderGroup } from "../../store/index.js";

/**
 * Block Alias's own confirmation (#103's own decision: "behind a
 * confirmation that names the exact Alias and says Approved Senders are
 * included"). A real shadcn `Dialog` rather than a browser `confirm()`, the
 * same "full shadcn for every floating primitive" posture
 * `ScreenerViewDialog.tsx` follows — this is the one Screener decision
 * that isn't a single click, because it is also the one that overrides an
 * Approved Sender.
 *
 * `group` doubles as both the open/closed flag and the target, the same
 * `null`-closes shape `ScreenerViewDialog` uses: nulling it out is
 * `Screener.tsx`'s own job, on confirm or cancel alike.
 */
export function BlockAliasDialog({
  group,
  onConfirm,
  onClose,
}: {
  /** `null` closes the dialog. */
  group: ScreenerSenderGroup | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const alias = group?.alias ?? null;

  return (
    <Dialog open={group !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="block-alias-dialog sm:max-w-md">
        {group && alias ? (
          <>
            <DialogHeader>
              <DialogTitle>Block everything sent to {alias}?</DialogTitle>
              <DialogDescription>
                Every message that arrives at {alias} moves straight to Trash from now on —
                including from senders you've approved. Whatever is currently held in the Screener
                for it is trashed too.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button type="button" className="block-alias-cancel" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="block-alias-confirm" onClick={onConfirm}>
                Block alias
              </button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
