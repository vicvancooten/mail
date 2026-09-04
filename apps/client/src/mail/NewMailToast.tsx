import type { PushPayload } from "@mail/shared";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { publishNotificationTarget } from "../pwa/notification-router.js";
import { buildNotificationContent, notificationClickTarget } from "../pwa/push-decisions.js";

/**
 * The inline toast half of ADR-0015's visible-window rule: "a visible
 * window suppresses the OS notification in favour of an inline toast
 * (sender + subject, click-to-open, ~6s, stacking capped at 3 and then
 * collapsing to 'N new messages' via the same burst rule)". The service
 * worker (`sw.ts`) decides suppression and relays the content via
 * `postMessage` — this component never sees a real `push` event, only that
 * relay, which is what makes it renderable/testable without one.
 *
 * Raised through Sonner (#93) via `toast.custom`, which keeps the click
 * target a real `<button>` the way the hand-rolled stack did — each arrival
 * gets its own toast id (`new-mail-toast-N`) so up to 3 can be visible at
 * once; the 4th dismisses all of them and raises one collapsed toast under
 * a fixed id instead, matching the "stacking capped at 3" rule exactly.
 *
 * Mounted once in `MailSection`, like `RollbackToast` — a push can arrive
 * with no Thread selected, no view in particular open.
 */

const AUTO_DISMISS_MS = 6_000;
/** "Stacking capped at 3 and then collapsing" — the fourth arrival within the same dismiss window replaces the stack with one collapsed toast. */
const STACK_CAP = 3;
const COLLAPSED_TOAST_ID = "new-mail-toast-collapsed";

interface NewMailToastMessage {
  type: "new-mail-toast";
  payload: PushPayload;
}

function isNewMailToastMessage(data: unknown): data is NewMailToastMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "new-mail-toast"
  );
}

/** The slice of `navigator.serviceWorker` this needs — narrowed so a test double beats faking the whole container (jsdom has none at all). */
export interface MessageContainer {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface NewMailToastProps {
  /** Defaults to `navigator.serviceWorker`; a test double stands in where jsdom has none. */
  container?: MessageContainer;
  /** Test seam — a real 6s timer has no place in a unit test. */
  autoDismissMs?: number;
}

export function NewMailToast({
  container = globalThis.navigator?.serviceWorker,
  autoDismissMs = AUTO_DISMISS_MS,
}: NewMailToastProps = {}) {
  // Which per-entry toast ids are currently up — tracked in a ref rather
  // than state, since nothing here ever needs to re-render: every visible
  // effect happens through `toast`/`toast.dismiss` directly.
  const liveIds = useRef<string[]>([]);

  const openThread = useCallback((payload: PushPayload) => {
    const target = notificationClickTarget(payload);
    // A collapsed-burst/digest toast has nowhere narrower to land than the
    // window it's already showing in — same as a real notification click on
    // those two kinds (`push-decisions.ts`). The other three route exactly
    // as a real notification click would.
    if (target.kind !== "focus-only") {
      publishNotificationTarget(target);
    }
    for (const id of liveIds.current) toast.dismiss(id);
    liveIds.current = [];
    toast.dismiss(COLLAPSED_TOAST_ID);
  }, []);

  useEffect(() => {
    if (!container) return;

    const onMessage = (event: MessageEvent) => {
      if (!isNewMailToastMessage(event.data)) return;
      const { payload } = event.data;

      if (liveIds.current.length >= STACK_CAP) {
        for (const id of liveIds.current) toast.dismiss(id);
        const collapsedCount = liveIds.current.length + 1;
        liveIds.current = [];
        toast(`${collapsedCount} new messages`, {
          id: COLLAPSED_TOAST_ID,
          duration: autoDismissMs,
        });
        return;
      }

      const content = buildNotificationContent(payload);
      const id = `new-mail-toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      liveIds.current = [...liveIds.current, id];
      toast.custom(
        () => (
          <button type="button" className="new-mail-toast" onClick={() => openThread(payload)}>
            <strong>{content.title}</strong>
            <span>{content.body}</span>
          </button>
        ),
        {
          id,
          duration: autoDismissMs,
          onDismiss: () => {
            liveIds.current = liveIds.current.filter((entry) => entry !== id);
          },
        },
      );
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, [container, autoDismissMs, openThread]);

  return null;
}
