import type { Message } from "@mail/shared";
import { ChevronRight, Forward, Reply, ReplyAll } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OnReply } from "../ThreadDetailPane.js";
import { AttachmentList } from "./AttachmentList.js";
import { MessageBody } from "./MessageBody.js";
import type { MailtoLink } from "./mailto.js";

/**
 * Every Message in an opened Thread, oldest first — the reading pane's
 * actual content (#41). Each Message's own Reply/Reply All/Forward row
 * (#47) is what reaches "the specific message the User had open" (compose-
 * spec §Threading headers) directly; `onOpenMessageChange` reports the same
 * notion — whichever Message is currently scrolled into view — up to
 * `ThreadDetailPane`, so its `r`/`a`/`f` keyboard shortcuts can target it
 * too, instead of unconditionally the newest Message in the Thread.
 *
 * `focusMessageId` (#51, `docs/search-ux-spec.md` §The row: "Opening a
 * result lands on the matched message") scrolls that Message into view once
 * this list's own Messages have loaded — the matched message id travels
 * with a search result row, this is where it lands.
 *
 * #291: in a long Thread the User lands on what is new, not the whole
 * history. The newest Message and every unread one render in full; every
 * other one collapses to sender, date and its own Snippet, and expands in
 * place on click — `toggled` only ever grows (there is no collapse-back-
 * down control, not asked for), and this component is unmounted with the
 * rest of `.reading-body` on every Reader open (`ThreadDetailPane`'s
 * `key={thread.id}`), which is what resets it per open rather than any
 * effect here watching `thread.id`.
 */
export function MessageList({
  messages,
  onReply,
  onMailtoLink,
  focusMessageId,
  onOpenMessageChange,
}: {
  messages: readonly Message[];
  onReply: OnReply;
  /** A `mailto:` link clicked inside a Message body (ADR-0018's click bridge, `MessageBody.tsx`). */
  onMailtoLink: (link: MailtoLink) => void;
  focusMessageId?: string | null;
  /** Reports the id of whichever Message is currently scrolled into view — see the doc comment above. */
  onOpenMessageChange?: (messageId: string) => void;
}) {
  const focusedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const openMessageIdRef = useRef<string | null>(null);
  const [expandedByClick, setExpandedByClick] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!focusMessageId || focusedRef.current) return;
    const target = messages.find((message) => message.id === focusMessageId);
    if (!target) return;
    focusedRef.current = true;
    document.getElementById(`message-${focusMessageId}`)?.scrollIntoView({ block: "start" });
  }, [messages, focusMessageId]);

  // Which Message is "open" for keyboard shortcuts (#47): whichever
  // rendered article currently sits closest to the top of the viewport
  // among those still visible. `root: null` (the browser viewport) works
  // here because the actual scrolling ancestor is `.thread-detail` further
  // up the tree — scrolling it still moves these articles relative to the
  // viewport, which is all `IntersectionObserver` needs to watch.
  useEffect(() => {
    if (!onOpenMessageChange || messages.length === 0) return;
    const container = containerRef.current;
    if (!container || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length === 0) return;
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0]?.target.getAttribute("data-message-id");
        if (id && id !== openMessageIdRef.current) {
          openMessageIdRef.current = id;
          onOpenMessageChange(id);
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    const articles = container.querySelectorAll<HTMLElement>("[data-message-id]");
    articles.forEach((article) => {
      observer.observe(article);
    });
    return () => observer.disconnect();
  }, [messages, onOpenMessageChange]);

  return (
    <div className="message-list" ref={containerRef}>
      {messages.map((message, index) => {
        // #291: the newest Message and every unread one open in full; a
        // search hit (`focusMessageId`) always wins over the collapsed
        // default too — landing on a match only to find it collapsed would
        // defeat the whole point of #51's "opening a result lands on the
        // matched message".
        const defaultExpanded = index === messages.length - 1 || !message.seen;
        const expanded =
          defaultExpanded || message.id === focusMessageId || expandedByClick.has(message.id);

        return (
          <article
            className={expanded ? "message-item" : "message-item message-item-collapsed"}
            key={message.id}
            id={`message-${message.id}`}
            data-message-id={message.id}
          >
            {expanded ? (
              <>
                <header className="message-item-header">
                  <span className="message-item-sender">
                    {message.from?.name ?? message.from?.address ?? "(unknown sender)"}
                  </span>
                  <time className="message-item-date" dateTime={message.sentAt}>
                    {new Date(message.sentAt).toLocaleString()}
                  </time>
                </header>
                <MessageBody key={message.id} message={message} onMailtoLink={onMailtoLink} />
                <AttachmentList message={message} />
                <div className="message-item-reply-actions">
                  <button type="button" onClick={() => onReply(message, "reply")} title="Reply (r)">
                    <Reply size={13} /> Reply
                  </button>
                  <button
                    type="button"
                    onClick={() => onReply(message, "replyAll")}
                    title="Reply all (a)"
                  >
                    <ReplyAll size={13} /> Reply all
                  </button>
                  <button
                    type="button"
                    onClick={() => onReply(message, "forward")}
                    title="Forward (f)"
                  >
                    <Forward size={13} /> Forward
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                className="message-item-summary"
                aria-label={`Expand message from ${message.from?.name ?? message.from?.address ?? "unknown sender"}`}
                onClick={() =>
                  setExpandedByClick((prev) => {
                    const next = new Set(prev);
                    next.add(message.id);
                    return next;
                  })
                }
              >
                <ChevronRight size={14} className="message-item-summary-chevron" />
                <span className="message-item-summary-sender">
                  {message.from?.name ?? message.from?.address ?? "(unknown sender)"}
                </span>
                <time className="message-item-summary-date" dateTime={message.sentAt}>
                  {new Date(message.sentAt).toLocaleDateString()}
                </time>
                <span className="message-item-summary-snippet">{message.snippet}</span>
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
}
