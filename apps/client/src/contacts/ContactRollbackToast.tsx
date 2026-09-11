import { useEffect } from "react";
import { raiseActionToast } from "../mail/action-toast.js";
import { contactRollbackMessage, subscribeContactRollbacks } from "./contact-rollback-toast.js";

/**
 * The "visible on every device" half of write-back's "upstream wins"
 * acceptance line (#216) — reverting the mirror already reaches every
 * device through the ordinary `Contact` delta (ADR-0011, the Sync Backend
 * writing the reverted row bumps `syncRev` the same as any other edit); this
 * is what narrates *why*, the same "a row quietly changing is easy to miss"
 * reasoning `mail/RollbackToast.tsx`'s own doc comment gives for Mail's
 * rejected Optimistic Actions.
 *
 * Mounted once in `RootLayout` — not scoped to the Contacts App the way
 * `mail/RollbackToast.tsx` is scoped to `MailSection` — since a write-back's
 * own confirmation can land at any point while the User is anywhere in the
 * app, on a route that never opened the Contacts App at all. No Calendar (or
 * any other) equivalent existed to reuse at the time of writing (checked
 * `main`/`feat/hub-apps-foundations`, neither carries one yet) — this is
 * `raiseActionToast`'s own shared surface, the one piece of "reuse rather
 * than invent a second mechanism" that *is* already there to reuse.
 */

const DEFAULT_AUTO_DISMISS_MS = 6_000;
const TOAST_ID = "contact-rollback-toast";

export function ContactRollbackToast({
  autoDismissMs = DEFAULT_AUTO_DISMISS_MS,
}: {
  /** Test seam, `mail/RollbackToast.tsx`'s own knob. */
  autoDismissMs?: number;
} = {}) {
  useEffect(() => {
    return subscribeContactRollbacks((rollback) => {
      raiseActionToast({
        id: TOAST_ID,
        message: contactRollbackMessage(rollback),
        durationMs: autoDismissMs,
      });
    });
  }, [autoDismissMs]);

  return null;
}
