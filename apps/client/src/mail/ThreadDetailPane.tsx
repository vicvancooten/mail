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
import { useCallback, useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import type { ReplyMode } from "../compose/reply.js";
import type { CachedThread } from "../store/index.js";
import { useLabels } from "../store/index.js";
import { Avatar } from "./Avatar.js";
import { ActionMenu } from "./actions/ActionMenu.js";
import { useActions } from "./actions/ActionsProvider.js";
import { actionById } from "./actions/registry.js";
import { publishReaderHandle } from "./actions/surface-handles.js";
import { withThread } from "./actions/types.js";
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
 * the mouse-reachable half of triage: the toolbar's run of icon buttons.
 * The Thread header (subject, participants, labels, actions) renders
 * instantly from the Local Cache; the sanitized, sandboxed message bodies
 * (#41, `reading/MessageList.js`) are a per-Thread fetch-through — the wire
 * `Thread` projection is a list-row summary, never a body — so the Snippet
 * shows first and the real content swaps in once it arrives.
 *
 * Right-click (or long-press, on touch) anywhere in the pane opens the
 * Action registry's menu for the open Thread (#94), the same list of
 * available actions a row's own menu shows. The pane no longer owns a
 * `keydown` listener: `L`, `h`, `u` and `r`/`a`/`f` are registry entries
 * like every other binding, run by the single listener in
 * `actions/ActionsProvider.tsx`, which reaches the two Popovers and the
 * open Message through the handle this pane publishes
 * (`actions/surface-handles.ts`).
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

  const latestMessage = messages?.at(-1) ?? null;
  const replyTarget =
    messages?.find((message) => message.id === openMessageId) ?? latestMessage ?? null;

  const openPicker = useCallback((which: "snooze" | "label") => {
    if (which === "snooze") setSnoozeMenuOpen((open) => !open);
    else setPickerOpen((open) => !open);
  }, []);

  // What the Action registry can reach *into* this pane (#94): the Message
  // `r`/`a`/`f` should act on, and the two pickers `h`/`L` open. This pane
  // used to own its own `keydown` listener for all five bindings — one of
  // the four the registry replaced — but the state they act on (which
  // Message is scrolled into view, whether a Popover is open) is genuinely
  // this component's, so it publishes a handle for the one listener to call
  // rather than lifting that state somewhere it doesn't belong
  // (`actions/surface-handles.ts`).
  useEffect(
    () => publishReaderHandle({ replyTarget, openPicker, onBack }),
    [replyTarget, openPicker, onBack],
  );

  const replyToName =
    replyTarget?.from?.name?.split(" ")[0] ?? replyTarget?.from?.address ?? participants;

  // The reader's own right-click / long-press menu (#94) — the same
  // registry the toolbar's icons and the keyboard read, narrowed to this
  // Thread. `withThread` is a no-op for the Thread that is already open, so
  // Reply/Snooze/Label stay available here in a way they can't be on a row
  // whose Messages aren't loaded.
  const actions = useActions();
  const readerCtx = actions ? withThread(actions, thread) : null;

  /**
   * One toolbar button's tooltip, with its keycap taken from the registry
   * rather than re-typed here (#94's own complaint: every binding was
   * spelled out again in every surface that showed it). A binding the
   * registry doesn't give — Mark read/unread has none since #79 — says so
   * instead of naming a key.
   */
  const buttonTitle = (id: string, name: string): string => {
    const display = actionById(id)?.binding?.display;
    return display ? `${name} (${display.toLowerCase()})` : `${name} — Command Palette only`;
  };
  /** Runs a registry action against the open Thread, or — with no provider above this pane — falls back to the `triage` prop the host handed it. */
  const runReader = (id: string, fallback: () => void) => {
    const action = actionById(id);
    if (readerCtx && action?.availability(readerCtx).available) action.run(readerCtx);
    else fallback();
  };

  return (
    <ActionMenu ctx={readerCtx} asChild label={`Actions for "${thread.subject || "(no subject)"}"`}>
      <div className="thread-detail" key={thread.id}>
        <div className="reading-header">
          <div className="reading-topline">
            {onBack ? (
              <button
                type="button"
                className="reading-back"
                onClick={onBack}
                aria-label="Back to list"
                title={buttonTitle("back-to-list", "Back to list")}
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
                    title={buttonTitle("prev-thread", "Previous thread")}
                  >
                    <ChevronUp size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={onNext}
                    disabled={!onNext}
                    aria-label="Next thread"
                    title={buttonTitle("next-thread", "Next thread")}
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
                title={buttonTitle("reply", "Reply")}
              >
                <Reply size={15} />
              </button>
              {/* Done is the App's primary verb, so it is the one icon in this
                run that takes the accent when reached for (the comp's own
                `[data-act="done"]` hover). */}
              <button
                type="button"
                data-act="done"
                onClick={() => runReader("done", () => triage.archive(thread.id))}
                aria-label="Done — archive this thread"
                title={buttonTitle("done", "Done")}
              >
                <CheckCircle2 size={15} />
              </button>
              <Popover open={snoozeMenuOpen} onOpenChange={setSnoozeMenuOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={snoozeMenuOpen ? "on" : ""}
                    aria-label="Snooze"
                    title={buttonTitle("snooze", "Snooze")}
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
                    title={buttonTitle("label", "Label")}
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
                onClick={() => runReader("pin", () => triage.togglePin(thread.id))}
                aria-label={thread.pinned ? "Unpin" : "Pin"}
                title={buttonTitle("pin", "Pin")}
              >
                <Pin size={15} />
              </button>
              <button
                type="button"
                className={thread.starred ? "on" : ""}
                aria-pressed={thread.starred}
                onClick={() => runReader("star", () => triage.toggleStar(thread.id))}
                aria-label={thread.starred ? "Unstar" : "Star"}
                title={buttonTitle("star", "Star")}
              >
                <Star size={15} />
              </button>
              <button
                type="button"
                onClick={() => runReader("toggle-read", () => triage.toggleRead(thread.id))}
                aria-label={unread ? "Mark read" : "Mark unread"}
                title={buttonTitle("toggle-read", "Toggle read/unread")}
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
                onClick={() => runReader("trash", () => triage.trash(thread.id))}
                aria-label="Move to trash"
                title={buttonTitle("trash", "Trash")}
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
              <span className="reading-time">
                {new Date(thread.lastMessageAt).toLocaleString()}
              </span>
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
          <button
            type="button"
            className="reply-hint"
            onClick={() => onReply(replyTarget, "reply")}
          >
            <Reply size={15} />
            Reply to {replyToName}…
          </button>
        ) : null}
      </div>
    </ActionMenu>
  );
}
