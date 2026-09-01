import {
  Archive,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Mail,
  MailOpen,
  Star,
  Trash2,
} from "lucide-react";
import type { CachedThread } from "../store/index.js";
import type { Triage } from "./useTriage.js";

/**
 * The opened-Thread pane: everything the Local Cache already holds about a
 * Thread, rendered with no network wait (#40's third acceptance box), plus
 * (#42) the mouse-reachable half of triage — `e`/`#`/`s`/`u` reach the same
 * four actions from the keyboard (`useTriage.ts`). The sanitized, sandboxed
 * message *body* is #41's job — the wire `Thread` projection is a list-row
 * summary, never a body, so this pane shows the Snippet in its place rather
 * than pretending to render mail content that doesn't live here yet.
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
  triage,
}: {
  thread: CachedThread;
  groupLabel?: string;
  onBack?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  triage: Triage;
}) {
  const participants =
    thread.participants.map((p) => p.name ?? p.address).join(", ") || "(no sender)";
  const unread = thread.unreadCount > 0;

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
        <div className="thread-detail-actions">
          <button type="button" onClick={() => triage.archive(thread.id)} title="Archive (e)">
            <Archive size={14} /> Archive
          </button>
          <button
            type="button"
            onClick={() => triage.trash(thread.id)}
            title="Trash (# / Backspace)"
          >
            <Trash2 size={14} /> Trash
          </button>
          <button
            type="button"
            className={thread.starred ? "on" : ""}
            onClick={() => triage.toggleStar(thread.id)}
            title="Toggle star (s)"
          >
            <Star size={14} fill={thread.starred ? "currentColor" : "none"} />
            {thread.starred ? "Unstar" : "Star"}
          </button>
          <button
            type="button"
            onClick={() => triage.toggleRead(thread.id)}
            title="Toggle read/unread (u)"
          >
            {unread ? <MailOpen size={14} /> : <Mail size={14} />}
            {unread ? "Mark read" : "Mark unread"}
          </button>
        </div>
      </div>
    </div>
  );
}
