import type { MutationIntent } from "@mail/shared";
import { useEffect, useState } from "react";
import { subscribeMutationRejections } from "../store/index.js";

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
 * Mounted once in `MailSection` — not per-row — since a rejection can
 * arrive well after the row that triggered it has scrolled out of view or
 * been unmounted entirely.
 */

const DEFAULT_AUTO_DISMISS_MS = 5_000;

function describeIntent(intent: MutationIntent): string {
  switch (intent.type) {
    case "archive":
      return "Couldn't archive — restored to the list.";
    case "trash":
      return "Couldn't move to trash — restored to the list.";
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
  }
}

export function RollbackToast({
  autoDismissMs = DEFAULT_AUTO_DISMISS_MS,
}: {
  /** Test seam — real timers throughout keeps this simple to drive against the real IndexedDB-backed queue. */
  autoDismissMs?: number;
}) {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    return subscribeMutationRejections((rejection) => {
      setMessage(describeIntent(rejection.intent));
    });
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), autoDismissMs);
    return () => clearTimeout(timer);
  }, [message, autoDismissMs]);

  if (!message) return null;

  return (
    <div className="rollback-toast" role="status">
      {message}
    </div>
  );
}
