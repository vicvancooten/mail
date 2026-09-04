import type { Message } from "@mail/shared";
import { labelNameFromId } from "@mail/shared";
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Clock,
  Mail,
  MailOpen,
  Pin,
  Reply,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import type { ReplyMode } from "../compose/reply.js";
import type { CachedThread } from "../store/index.js";
import { useLabels } from "../store/index.js";
import { Avatar } from "./Avatar.js";
import { LabelPicker } from "./LabelPicker.js";
import { MessageList } from "./reading/MessageList.js";
import type { MailtoLink } from "./reading/mailto.js";
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
  onMailtoLink,
  focusMessageId,
}: {
  thread: CachedThread;
  groupLabel?: string;
  onBack?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  triage: Triage;
  onReply: OnReply;
  /** A `mailto:` link clicked inside a Message body (ADR-0018's click bridge) — forwarded to `MessageList`. */
  onMailtoLink: (link: MailtoLink) => void;
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

  const latestMessage = messages?.at(-1) ?? null;
  const replyTarget =
    messages?.find((message) => message.id === openMessageId) ?? latestMessage ?? null;
  const replyToName =
    replyTarget?.from?.name?.split(" ")[0] ?? replyTarget?.from?.address ?? participants;

  return (
    <div className="thread-detail" key={thread.id}>
      <div className="reading-header">
        <div className="reading-topline">
          {onBack ? (
            <button
              type="button"
              className="reading-back"
              onClick={onBack}
              aria-label="Back to list"
              title="Back to list (u)"
            >
              <ChevronLeft size={16} />
            </button>
          ) : null}
          <div className="reading-heading">
            {groupLabel ? <div className="reading-eyebrow">{groupLabel}</div> : null}
            <h1 className="reading-subject">{thread.subject || "(no subject)"}</h1>
          </div>
          <div className="reading-actions">
            {onPrev || onNext ? (
              <>
                <button
                  type="button"
                  onClick={onPrev}
                  disabled={!onPrev}
                  aria-label="Previous thread"
                  title="Previous thread (k)"
                >
                  <ChevronUp size={15} />
                </button>
                <button
                  type="button"
                  onClick={onNext}
                  disabled={!onNext}
                  aria-label="Next thread"
                  title="Next thread (j)"
                >
                  <ChevronDown size={15} />
                </button>
                <span className="reading-actions-gap" />
              </>
            ) : null}
            <button
              type="button"
              onClick={() => {
                if (replyTarget) onReply(replyTarget, "reply");
              }}
              disabled={!replyTarget}
              aria-label="Reply"
              title="Reply (r)"
            >
              <Reply size={15} />
            </button>
            {/* Done is the App's primary verb, so it is the one icon in this
                run that takes the accent when reached for (the comp's own
                `[data-act="done"]` hover). */}
            <button
              type="button"
              data-act="done"
              onClick={() => triage.archive(thread.id)}
              aria-label="Done — archive this thread"
              title="Done (e)"
            >
              <CheckCircle2 size={15} />
            </button>
            <Popover open={snoozeMenuOpen} onOpenChange={setSnoozeMenuOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={snoozeMenuOpen ? "on" : ""}
                  aria-label="Snooze"
                  title="Snooze (h)"
                >
                  <Clock size={15} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto min-w-[200px] p-1.5">
                <SnoozeMenu
                  thread={thread}
                  onSnooze={(until) => {
                    triage.snooze(thread.id, until);
                    setSnoozeMenuOpen(false);
                  }}
                  onClose={() => setSnoozeMenuOpen(false)}
                />
              </PopoverContent>
            </Popover>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={pickerOpen ? "on" : ""}
                  aria-label="Apply or remove a label"
                  title="Label (L)"
                >
                  <Tag size={15} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto min-w-[220px] p-1.5">
                <LabelPicker
                  thread={thread}
                  labels={labels}
                  triage={triage}
                  onClose={() => setPickerOpen(false)}
                />
              </PopoverContent>
            </Popover>
            <button
              type="button"
              className={thread.pinned ? "on" : ""}
              aria-pressed={thread.pinned}
              onClick={() => triage.togglePin(thread.id)}
              aria-label={thread.pinned ? "Unpin" : "Pin"}
              title="Pin (p)"
            >
              <Pin size={15} />
            </button>
            <button
              type="button"
              className={thread.starred ? "on" : ""}
              aria-pressed={thread.starred}
              onClick={() => triage.toggleStar(thread.id)}
              aria-label={thread.starred ? "Unstar" : "Star"}
              title="Star (s)"
            >
              <Star size={15} />
            </button>
            <button
              type="button"
              onClick={() => triage.toggleRead(thread.id)}
              aria-label={unread ? "Mark read" : "Mark unread"}
              title="Toggle read/unread — Command Palette only, no key of its own"
            >
              {unread ? <MailOpen size={15} /> : <Mail size={15} />}
            </button>
            {/* Trash keeps its distance and stays quiet until reached for:
                in a triage app it is one keystroke away, so the design owes
                it room rather than a red button in the run. */}
            <span className="reading-actions-gap" />
            <button
              type="button"
              className="destructive"
              onClick={() => triage.trash(thread.id)}
              aria-label="Move to trash"
              title="Trash (# / Backspace)"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>
        <div className="reading-meta">
          <Avatar name={participants} className="reading-avatar" />
          <span className="reading-identity">
            <span className="reading-from">{participants}</span>
            <span className="reading-addr">
              {thread.messageCount} message{thread.messageCount === 1 ? "" : "s"}
              {thread.labelIds.length > 0 ? (
                <span className="reading-labels">
                  {thread.labelIds.map((id) => (
                    <span key={id} className="label-chip">
                      {labels.find((label) => label.id === id)?.name ??
                        labelNameFromId(thread.mailAccountId, id)}
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
          </span>
          {thread.lastMessageAt ? (
            <span className="reading-time">{new Date(thread.lastMessageAt).toLocaleString()}</span>
          ) : null}
        </div>
      </div>

      <div className="reading-body">
        {messages ? (
          <MessageList
            messages={messages}
            onReply={onReply}
            onMailtoLink={onMailtoLink}
            focusMessageId={focusMessageId}
            onOpenMessageChange={setOpenMessageId}
          />
        ) : thread.snippet ? (
          <p className="reading-snippet">{thread.snippet}</p>
        ) : (
          <p className="reading-snippet placeholder">No preview cached yet.</p>
        )}
      </div>

      {/* The comp's `.reply-hint`: the reply composer at rest — a quiet
          filled bar across the foot of the pane that names who it would
          answer, rather than an empty editor holding the page open. */}
      {replyTarget ? (
        <button type="button" className="reply-hint" onClick={() => onReply(replyTarget, "reply")}>
          <Reply size={15} />
          Reply to {replyToName}…
        </button>
      ) : null}
    </div>
  );
}
