import type { Message } from "@mail/shared";
import { labelNameFromId } from "@mail/shared";
import {
  Archive,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Clock,
  MailOpen,
  Pin,
  SquarePen,
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
import { SnoozeMenu } from "./SnoozeMenu.js";
import type { Triage } from "./useTriage.js";

/** Reply / reply-all / forward, against one specific Message (compose-spec §Threading headers). */
export type OnReply = (message: Message, mode: ReplyMode) => void;

/**
 * The opened-Thread pane: everything the Local Cache already holds about a
 * Thread, rendered with no network wait (#40's third acceptance box), plus
 * (#42) the mouse-reachable half of triage — `e`/`#`/`s` reach the same
 * three actions from the keyboard (`useTriage.ts`). Pin and Label (#43) join
 * it here too: `p` toggles Pin through the same `useTriage` scheme, and `L`
 * opens `LabelPicker` — its own binding, since which Label is a name, not a
 * boolean toggle. `h` and `u` (#79, rebound from `useTriage`'s old
 * move-left and mark-unread) are this pane's own too: `h` opens `SnoozeMenu`
 * for the open Thread — the same popover `ThreadRow`'s Snooze button opens,
 * just anchored here instead — and `u` calls `onBack`, the same "Back to
 * list" pill already does. The Thread header (subject, participants, labels, actions)
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
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  // The Message `r`/`a`/`f` below should act on: whichever one `MessageList`
  // reports as currently scrolled into view (`onOpenMessageChange`), same
  // notion its own per-Message Reply/Reply All/Forward buttons already
  // reach directly. Defaults to the newest Message until a scroll position
  // is reported — matching where the reading pane lands on open.
  const [openMessageId, setOpenMessageId] = useState<string | null>(null);

  // `L` opens/closes the Label picker (#43), `r`/`a`/`f` reply/reply-all/
  // forward (#47, compose-spec §Threading headers: act on "the specific
  // message the User had open") — one window keydown listener, the same
  // "one component owns one binding" shape `VirtualizedThreadList` already
  // uses for `j`/`k`, rather than routing through `useTriage`'s scheme
  // (which never needs to know *which* Label, or *which* Message).
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
      if (event.key === "h") {
        setSnoozeMenuOpen((open) => !open);
        return;
      }
      if (event.key === "u") {
        onBack?.();
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
      const open = messages?.find((message) => message.id === openMessageId) ?? messages?.at(-1);
      if (!open) return;
      event.preventDefault();
      onReply(open, mode);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [messages, openMessageId, onReply, onBack]);

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
          {thread.pinned ? <Pin size={14} className="pin" /> : null}
          {thread.starred ? <Star size={14} className="star" /> : null}
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
            className={thread.starred ? "on" : ""}
            onClick={() => triage.toggleStar(thread.id)}
            title="Toggle star (s)"
          >
            <Star size={14} />
            {thread.starred ? "Unstar" : "Star"}
          </button>
          <button
            type="button"
            onClick={() => triage.toggleRead(thread.id)}
            title="Toggle read/unread — Command Palette only, no key of its own"
          >
            {unread ? <MailOpen size={14} /> : <SquarePen size={14} />}
            {unread ? "Mark read" : "Mark unread"}
          </button>
          <button
            type="button"
            className={thread.pinned ? "on" : ""}
            onClick={() => triage.togglePin(thread.id)}
            title="Toggle pin (p)"
          >
            <Pin size={14} />
            {thread.pinned ? "Unpin" : "Pin"}
          </button>
          <div className="snooze-menu-anchor">
            <button
              type="button"
              className={snoozeMenuOpen ? "on" : ""}
              aria-haspopup="menu"
              aria-expanded={snoozeMenuOpen}
              onClick={() => setSnoozeMenuOpen((open) => !open)}
              title="Snooze (h)"
            >
              <Clock size={14} /> Snooze
            </button>
            {snoozeMenuOpen ? (
              <SnoozeMenu
                thread={thread}
                onSnooze={(until) => {
                  triage.snooze(thread.id, until);
                  setSnoozeMenuOpen(false);
                }}
                onClose={() => setSnoozeMenuOpen(false)}
              />
            ) : null}
          </div>
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
          {/* Last in the run, and outline until reached for: Trash is one
              keystroke away everywhere else, so here it keeps its distance
              (`.thread-detail-actions button.destructive` in mail.css). */}
          <button
            type="button"
            className="destructive"
            onClick={() => triage.trash(thread.id)}
            title="Trash (# / Backspace)"
          >
            <Trash2 size={14} /> Trash
          </button>
        </div>
        {messages ? (
          <MessageList
            messages={messages}
            onReply={onReply}
            focusMessageId={focusMessageId}
            onOpenMessageChange={setOpenMessageId}
          />
        ) : null}
      </div>
    </div>
  );
}
