import type { Message } from "@mail/shared";
import { labelNameFromId } from "@mail/shared";
import {
  Archive,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Mail,
  MailOpen,
  Pin,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReplyMode } from "../compose/reply.js";
import type { CachedThread } from "../store/index.js";
import { useLabels } from "../store/index.js";
import { LabelPicker } from "./LabelPicker.js";
import { MessageList } from "./reading/MessageList.js";
import { useThreadMessages } from "./reading/useThreadMessages.js";
import type { Triage } from "./useTriage.js";

/** Reply / reply-all / forward, against one specific Message (compose-spec §Threading headers). */
export type OnReply = (message: Message, mode: ReplyMode) => void;

/**
 * The opened-Thread pane: everything the Local Cache already holds about a
 * Thread, rendered with no network wait (#40's third acceptance box), plus
 * (#42) the mouse-reachable half of triage — `e`/`#`/`s`/`u` reach the same
 * four actions from the keyboard (`useTriage.ts`). Pin and Label (#43) join
 * it here too: `p` toggles Pin through the same `useTriage` scheme, and `L`
 * opens `LabelPicker` — its own binding, since which Label is a name, not a
 * boolean toggle. The Thread header (subject, participants, labels, actions)
 * renders instantly from the Local Cache; the sanitized, sandboxed message
 * bodies (#41, `reading/MessageList.js`) are a per-Thread fetch-through —
 * the wire `Thread` projection is a list-row summary, never a body — so the
 * Snippet shows first and the real content swaps in once it arrives.
 *
 * Shared between Split's side-by-side pane and List/Stream's full-screen
 * swap — `onBack` is present only for hosts that have a list to return to.
 * Every host renders this with `key={thread.id}` (not just the inner div
 * below, which is about the card-enter animation restarting): the Label
 * picker's `pickerOpen` local state needs a fresh mount per Thread rather
 * than an effect resetting it on `thread.id` change.
 */
export function ThreadDetailPane({
  thread,
  groupLabel,
  onBack,
  onPrev,
  onNext,
  triage,
  onReply,
  focusMessageId,
}: {
  thread: CachedThread;
  groupLabel?: string;
  onBack?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  triage: Triage;
  onReply: OnReply;
  /** A search result's matched message (#51) — forwarded to `MessageList`, see its own doc comment. */
  focusMessageId?: string | null;
}) {
  const participants =
    thread.participants.map((p) => p.name ?? p.address).join(", ") || "(no sender)";
  const unread = thread.unreadCount > 0;
  const labels = useLabels(thread.mailAccountId) ?? [];
  const { messages } = useThreadMessages(thread.id);

  const [pickerOpen, setPickerOpen] = useState(false);

  // `L` opens/closes the Label picker (#43), `r`/`a`/`f` reply/reply-all/
  // forward (#47, compose-spec §Composer surface & keys) — one window
  // keydown listener, the same "one component owns one binding" shape
  // `VirtualizedThreadList` already uses for `j`/`k`, rather than routing
  // through `useTriage`'s scheme (which never needs to know *which* Label,
  // or *which* Message). `r`/`a`/`f` always act on the newest Message in the
  // Thread — the reading pane's own per-Message Reply/Reply All/Forward
  // buttons (`reading/MessageList.tsx`) are what reaches "the specific
  // message the User had open" when that isn't the newest one.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      if (event.key === "L") {
        setPickerOpen((open) => !open);
        return;
      }
      const mode =
        event.key === "r"
          ? "reply"
          : event.key === "a"
            ? "replyAll"
            : event.key === "f"
              ? "forward"
              : null;
      if (!mode) return;
      const newest = messages?.at(-1);
      if (!newest) return;
      event.preventDefault();
      onReply(newest, mode);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [messages, onReply]);

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
          {thread.pinned ? <Pin size={14} className="pin" fill="currentColor" /> : null}
          {thread.starred ? <Star size={14} className="star" fill="currentColor" /> : null}
        </div>
        <h1>{thread.subject || "(no subject)"}</h1>
        <p className="thread-detail-meta">
          {thread.messageCount} message{thread.messageCount === 1 ? "" : "s"}
          {thread.lastMessageAt
            ? ` · last ${new Date(thread.lastMessageAt).toLocaleString()}`
            : null}
        </p>
        {thread.labelIds.length > 0 ? (
          <div className="thread-detail-labels">
            {thread.labelIds.map((id) => (
              <span key={id} className="label-chip">
                {labels.find((label) => label.id === id)?.name ??
                  labelNameFromId(thread.mailAccountId, id)}
              </span>
            ))}
          </div>
        ) : null}
        {messages === null &&
          (thread.snippet ? (
            <p className="thread-detail-snippet">{thread.snippet}</p>
          ) : (
            <p className="thread-detail-snippet placeholder">No preview cached yet.</p>
          ))}
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
          <button
            type="button"
            className={thread.pinned ? "on" : ""}
            onClick={() => triage.togglePin(thread.id)}
            title="Toggle pin (p)"
          >
            <Pin size={14} fill={thread.pinned ? "currentColor" : "none"} />
            {thread.pinned ? "Unpin" : "Pin"}
          </button>
          <div className="label-picker-anchor">
            <button
              type="button"
              className={pickerOpen ? "on" : ""}
              onClick={() => setPickerOpen((open) => !open)}
              title="Apply/remove label (L)"
            >
              <Tag size={14} /> Label
            </button>
            {pickerOpen ? (
              <LabelPicker
                thread={thread}
                labels={labels}
                triage={triage}
                onClose={() => setPickerOpen(false)}
              />
            ) : null}
          </div>
        </div>
        {messages ? (
          <MessageList messages={messages} onReply={onReply} focusMessageId={focusMessageId} />
        ) : null}
      </div>
    </div>
  );
}
