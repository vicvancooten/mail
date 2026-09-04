import type { MutationIntent } from "@mail/shared";
import { useEffect } from "react";
import { enqueueMutation, subscribeMutationRejections } from "../store/index.js";
import { raiseActionToast } from "./action-toast.js";

/**
 * The "visible rollback on failure" acceptance box (#44) — swipe's own
 * gesture already puts a Thread's row back where it was the instant
 * `mutation-queue.ts` deletes a rejected row (ADR-0010: rollback *is* a row
 * deletion, and `reads.ts`'s overlay is reactive), but a row quietly
 * reappearing lower in a list the User has already swiped past is easy to
 * miss entirely. This is `subscribeMutationRejections`'s "future toast"
 * (its own doc comment) landing: one line, auto-dismissing, naming what
 * failed rather than just that something did.
 *
 * Raised through the same `action-toast.ts` call every other Triage toast
 * uses (#95, `undo-toast.ts`/`GroupBulkToast.tsx`) — mounted once as
 * `<Toaster />` in `RootLayout`, so a rollback is visible from any route,
 * not just Mail. Renders no DOM of its own; a fixed `id` means a second
 * rejection arriving before the first toast dismisses replaces it in place
 * rather than stacking, the same "one message at a time" posture the
 * hand-rolled version had.
 *
 * Gains the Retry ADR-0011 promised (#95): "a rollback as the row visibly
 * reverting plus a toast naming the action, with a retry" — clicking it
 * re-enqueues the exact same intent that was rejected, on the same Mail
 * Account. A distinct surface from `undo-toast.ts`'s Undo toasts on
 * purpose (ADR-0019's own "never `revert`/`rollback`, which is the Sync
 * Backend rejecting an action, not the User reversing one") — this is the
 * Sync Backend saying no, not the User changing their mind.
 *
 * Mounted once in `MailSection` — not per-row — since a rejection can
 * arrive well after the row that triggered it has scrolled out of view or
 * been unmounted entirely.
 */

const DEFAULT_AUTO_DISMISS_MS = 5_000;
const TOAST_ID = "mail-rollback-toast";

function describeIntent(intent: MutationIntent): string | null {
  switch (intent.type) {
    case "archive":
      return "Couldn't archive — restored to the list.";
    case "trash":
      return "Couldn't move to trash — restored to the list.";
    case "snooze":
      return "Couldn't snooze — restored to the list.";
    case "restoreToInbox":
      return "Couldn't restore to the Inbox.";
    case "unsnooze":
      return "Couldn't unsnooze.";
    case "setStarred":
      return intent.starred ? "Couldn't star — undone." : "Couldn't unstar — undone.";
    case "setRead":
      return intent.read ? "Couldn't mark as read — undone." : "Couldn't mark as unread — undone.";
    case "setPinned":
      return intent.pinned ? "Couldn't pin — undone." : "Couldn't unpin — undone.";
    case "applyLabel":
      return `Couldn't apply "${intent.name}" — undone.`;
    case "removeLabel":
      return `Couldn't remove "${intent.name}" — undone.`;
    // The Composition intents (#46) have their own, better-placed surfaces —
    // the Undo Send bar says "too late to undo", the send-failure banner
    // carries the SMTP rejection verbatim — and both outlive a 5s toast on
    // purpose. Nothing to say here.
    case "sendComposition":
    case "cancelSend":
      return null;
    // The Mail-Account-scoped Preference intents (#54) have their own
    // surface too — the settings screen shows its own save state — so, same
    // as the Composition intents above, nothing for this toast to say.
    case "setSignature":
    case "setNotificationsEnabled":
      return null;
    // The Gatekeeper decisions (#55). Unlike the two groups above these have
    // no other surface that would report a failure — the Screener row simply
    // comes back — so they say so here.
    case "approveSender":
      return "Couldn't approve — the sender is still waiting in the Screener.";
    case "denySender":
      return "Couldn't deny — the sender is still waiting in the Screener.";
    case "blockSender":
      return "Couldn't block — the sender is still waiting in the Screener.";
    case "spamSender":
      return "Couldn't mark as spam — the sender is still waiting in the Screener.";
    case "unblockSender":
      return "Couldn't unblock — they are still blocked.";
    case "unblockAndRestore":
      return "Couldn't undo — they're still blocked and the mail is still in Trash.";
  }
}

export function RollbackToast({
  autoDismissMs = DEFAULT_AUTO_DISMISS_MS,
}: {
  /** Test seam — same knob the hand-rolled version had, now Sonner's own `duration`. */
  autoDismissMs?: number;
} = {}) {
  useEffect(() => {
    return subscribeMutationRejections((rejection) => {
      // An intent with nothing to say here (the Composition ones) must not
      // clear a toast a real rollback is still showing.
      const described = describeIntent(rejection.intent);
      if (described) {
        raiseActionToast({
          id: TOAST_ID,
          message: described,
          durationMs: autoDismissMs,
          action: {
            label: "Retry",
            onClick: () => {
              void enqueueMutation(rejection.intent, rejection.mailAccountId);
            },
          },
        });
      }
    });
  }, [autoDismissMs]);

  return null;
}
