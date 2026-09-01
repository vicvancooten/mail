import { ArrowLeft, ChevronLeft, ChevronRight, Star } from "lucide-react";
import type { CachedThread } from "../store/index.js";

/**
 * The opened-Thread pane: everything the Local Cache already holds about a
 * Thread, rendered with no network wait (#40's third acceptance box). The
 * sanitized, sandboxed message *body* is #41's job — the wire `Thread`
 * projection is a list-row summary, never a body, so this pane shows the
 * Snippet in its place rather than pretending to render mail content that
 * doesn't live here yet.
 *
 * Shared between Split's side-by-side pane and List/Stream's full-screen
 * swap — `onBack` is present only for hosts that have a list to return to.
 */
export function ThreadDetailPane({
  thread,
  groupLabel,
  onBack,
  onPrev,
  onNext,
}: {
  thread: CachedThread;
  groupLabel?: string;
  onBack?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const participants =
    thread.participants.map((p) => p.name ?? p.address).join(", ") || "(no sender)";

  return (
    <div className="thread-detail" key={thread.id}>
      <div className="thread-detail-nav">
        {onBack ? (
          <button type="button" className="back-pill" onClick={onBack}>
            <ArrowLeft size={15} /> Back to list
          </button>
        ) : null}
        {onPrev || onNext ? (
          <div className="chevrons">
            <button type="button" onClick={onPrev} disabled={!onPrev} title="Previous thread">
              <ChevronLeft size={18} />
            </button>
            <button type="button" onClick={onNext} disabled={!onNext} title="Next thread">
              <ChevronRight size={18} />
            </button>
          </div>
        ) : null}
      </div>
      <div className="thread-detail-card">
        {groupLabel ? <div className="group-label">{groupLabel}</div> : null}
        <div className="thread-detail-header">
          <span className="sender">{participants}</span>
          {thread.starred ? <Star size={14} className="star" fill="currentColor" /> : null}
        </div>
        <h1>{thread.subject || "(no subject)"}</h1>
        <p className="thread-detail-meta">
          {thread.messageCount} message{thread.messageCount === 1 ? "" : "s"}
          {thread.lastMessageAt
            ? ` · last ${new Date(thread.lastMessageAt).toLocaleString()}`
            : null}
        </p>
        {thread.snippet ? (
          <p className="thread-detail-snippet">{thread.snippet}</p>
        ) : (
          <p className="thread-detail-snippet placeholder">No preview cached yet.</p>
        )}
      </div>
    </div>
  );
}
