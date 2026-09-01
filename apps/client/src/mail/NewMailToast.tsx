import type { PushPayload } from "@mail/shared";
import { useEffect, useState } from "react";
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
 * Mounted once in `MailSection`, like `RollbackToast` — a push can arrive
 * with no Thread selected, no view in particular open.
 */

const AUTO_DISMISS_MS = 6_000;
/** "Stacking capped at 3 and then collapsing" — the fourth arrival within the same dismiss window replaces the stack with one collapsed toast. */
const STACK_CAP = 3;

interface ToastEntry {
  id: string;
  title: string;
  body: string;
  payload: PushPayload;
}

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
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  const [collapsedCount, setCollapsedCount] = useState<number | null>(null);

  useEffect(() => {
    if (!container) return;

    const onMessage = (event: MessageEvent) => {
      if (!isNewMailToastMessage(event.data)) return;
      const { payload } = event.data;
      const content = buildNotificationContent(payload);
      setEntries((current) => {
        const next = [
          ...current,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            title: content.title,
            body: content.body,
            payload,
          },
        ];
        if (next.length > STACK_CAP) {
          setCollapsedCount(next.length);
          return [];
        }
        return next;
      });
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, [container]);

  useEffect(() => {
    if (entries.length === 0 && collapsedCount === null) return;
    const timer = setTimeout(() => {
      setEntries([]);
      setCollapsedCount(null);
    }, autoDismissMs);
    return () => clearTimeout(timer);
  }, [entries, collapsedCount, autoDismissMs]);

  function openThread(payload: PushPayload): void {
    const target = notificationClickTarget(payload);
    // A burst/failed-send/needs-reauth toast has nowhere narrower to land
    // than the window it's already showing in — same as a real
    // notification click on those kinds (`push-decisions.ts`).
    if (target.kind === "thread") {
      publishNotificationTarget({ mailAccountId: target.mailAccountId, threadId: target.threadId });
    }
    setEntries([]);
    setCollapsedCount(null);
  }

  if (collapsedCount !== null) {
    return (
      <div className="new-mail-toast-stack" role="status">
        <div className="new-mail-toast new-mail-toast-collapsed">{collapsedCount} new messages</div>
      </div>
    );
  }
  if (entries.length === 0) return null;

  return (
    <div className="new-mail-toast-stack" role="status">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="new-mail-toast"
          onClick={() => openThread(entry.payload)}
        >
          <strong>{entry.title}</strong>
          <span>{entry.body}</span>
        </button>
      ))}
    </div>
  );
}
