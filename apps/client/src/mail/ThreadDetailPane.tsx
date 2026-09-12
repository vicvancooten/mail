import type { Message } from "@mail/shared";
import { CheckCircle2, ChevronLeft, Clock, Reply, ReplyAll, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover.js";
import type { ReplyMode } from "../compose/reply.js";
import { SenderContactCard } from "../contacts/SenderContactCard.js";
import type { CachedThread } from "../store/index.js";
import { labelNameForId, useLabels, useMailAccounts } from "../store/index.js";
import { Avatar } from "./Avatar.js";
import { ActionMenu } from "./actions/ActionMenu.js";
import { useActions } from "./actions/ActionsProvider.js";
import { ReaderOverflowMenu } from "./actions/ReaderOverflowMenu.js";
import {
  actionById,
  mailOverflowActions,
  READER_MAIL_PRIMARY_IDS,
  replyOverflowActions,
  sendToActions,
} from "./actions/registry.js";
import { publishReaderHandle } from "./actions/surface-handles.js";
import { noopActionContext, withThread } from "./actions/types.js";
import { InviteCard } from "./InviteCard.js";
import { LabelPicker } from "./LabelPicker.js";
import { ReaderTaskChips } from "./ReaderTaskChips.js";
import { MessageList } from "./reading/MessageList.js";
import type { MailtoLink } from "./reading/mailto.js";
import { chooseReplyMode, selfAddressFor } from "./reading/reply-mode.js";
import { useInvitationCards } from "./reading/useInvitationCards.js";
import { useThreadMessages } from "./reading/useThreadMessages.js";
import { SnoozeMenu } from "./SnoozeMenu.js";
import { useSwipeToNavigate } from "./useSwipeToNavigate.js";
import type { Triage } from "./useTriage.js";

/** Reply / reply-all / forward, against one specific Message (compose-spec §Threading headers). */
export type OnReply = (message: Message, mode: ReplyMode) => void;

/**
 * The opened-Thread pane: everything the Local Cache already holds about a
 * Thread, rendered with no network wait (#40's third acceptance box), plus
 * the mouse-reachable half of triage: the toolbar's run of icon buttons, in
 * three groups (#289, replacing #143's primary/secondary/more tiers) — Reply,
 * Mail, and Integrations — each a context-sensitive or always-visible inline
 * control plus its own overflow (`ReaderOverflowMenu`). The Thread's subject,
 * participants and labels render instantly from the Local Cache, as does
 * this fixed action bar above them (#290: everything from the subject down
 * is one scrolling document — see `.reading-body` below — the action bar is
 * the only chrome that stays pinned); the sanitized, sandboxed message bodies
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
  onOpenTask,
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
  /** A Task chip's title (#259, `ReaderTaskChips.tsx`'s own doc comment) — forwarded straight through, this pane stays router-agnostic. */
  onOpenTask: (taskId: string) => void;
  /** A search result's matched message (#51) — forwarded to `MessageList`, see its own doc comment. */
  focusMessageId?: string | null;
}) {
  const participants =
    thread.participants.map((p) => p.name ?? p.address).join(", ") || "(no sender)";
  // The Contact Card's own "sender" (#293): `participants` above is every
  // correspondent joined into one string (this pane's existing identity
  // line, and `ThreadRow.tsx`'s own Avatar seed) — a Contact Card needs one
  // real address to look up, so it reads the first entry of `participants`
  // (`sync/thread-rollup.ts#collectParticipants`'s own "oldest message
  // first" order), the same correspondent this Avatar already represents in
  // the common one-correspondent Thread.
  const primarySender = thread.participants[0] ?? null;
  // Labels are User-scoped, not Mail-Account-scoped (#186, ADR-0023) —
  // `useLabels()` takes no account id.
  const labels = useLabels() ?? [];
  // The Reply group's own primary rule (#289): Reply All when more than one
  // other participant is on the Thread, else Reply. `selfAddress` is this
  // Thread's owning Mail Account's own address — the same account
  // `MailSection.tsx`'s own `openReply` resolves a reply's From from
  // (`message.mailAccountId`/`thread.mailAccountId`), not Account Scope's
  // primary account.
  const mailAccounts = useMailAccounts();
  const selfAddress = selfAddressFor(mailAccounts, thread);
  const replyMode = chooseReplyMode(thread, selfAddress);
  const replyPrimaryId = replyMode === "replyAll" ? "reply-all" : "reply";
  const { messages } = useThreadMessages(thread.id);
  const { cards: invitationCards } = useInvitationCards(thread.id);

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

  // The reader's own right-click / long-press menu (#94), toolbar and each
  // group's overflow (#289) — the same registry the keyboard reads, narrowed
  // to this Thread. `withThread` is a no-op for the Thread that is already open, so
  // Reply/Snooze/Label stay available here in a way they can't be on a row
  // whose Messages aren't loaded. A pane rendered with no `ActionsProvider`
  // above it (a unit test rendering this component on its own) falls back to
  // a standalone context built from this pane's own props — `triage`,
  // `onReply`, `onBack` — so every tier below still renders from the
  // registry rather than needing its own separate no-provider branch.
  const actions = useActions();
  const readerCtx = actions
    ? withThread(actions, thread)
    : noopActionContext({
        thread,
        triage,
        latestMessage,
        labels,
        onReply,
        onBackToList: onBack ?? (() => {}),
      });

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
  /** Runs a registry action against the open Thread — always through `readerCtx`, which is never absent (see above). */
  const runReader = (id: string, fallback: () => void) => {
    const action = actionById(id);
    if (action?.availability(readerCtx).available) action.run(readerCtx);
    else fallback();
  };

  // The three groups themselves (#289): `mailPrimaryIds` is the registry's
  // own answer for which ids the Mail group always shows inline
  // (`READER_MAIL_PRIMARY_IDS`), not a separate hand-kept list — it gates
  // Done/Snooze/Trash below (Snooze and Label still need their own Popovers,
  // so this pane can't render a plain generic loop the way each group's
  // overflow does; each button's own `disabled` still comes from
  // `availability`, unchanged). Reply's own primary is `replyPrimaryId`
  // above, not a tag here — which of Reply/Reply All shows inline is a
  // per-Thread participant count, not a fixed set. Every overflow
  // (`ReaderOverflowMenu`) reads the registry directly with no intermediary,
  // and on every surface alike: #289 drops #143's touch-capable-phone fold,
  // since nothing here is inline-only-on-desktop any more.
  const mailPrimaryIds = READER_MAIL_PRIMARY_IDS;

  // #150: swipe right for the previous (newer) Thread, left for the next
  // (older) one — the same `onPrev`/`onNext` the (desktop-only) chevron
  // buttons above call, so the neighbour, the end-of-list no-op, and the
  // history-replace all come free from reusing that one callback pair. Not
  // gated on `phone`: like #149's row/Stream swipe, the underlying gesture
  // is already a no-op for anything but a touch pointer, so wiring it
  // unconditionally costs nothing when a mouse is what's dragging (or when
  // neither neighbour exists, since `onPrev`/`onNext` are then both absent
  // and the hook's commits are no-ops). Only spread onto the pane when at
  // least one neighbour exists, so Stream's own `ThreadDetailPane` — which
  // never passes either — never gets a second, redundant pointer listener
  // stacked under its own card-swipe-to-triage surface.
  const nav = useSwipeToNavigate({ onPrev, onNext });
  const swipeNavigable = Boolean(onPrev || onNext);

  return (
    <ActionMenu ctx={readerCtx} asChild label={`Actions for "${thread.subject || "(no subject)"}"`}>
      <div
        className={`thread-detail${swipeNavigable ? " thread-detail-swipeable" : ""}`}
        key={thread.id}
        {...(swipeNavigable ? nav.handlers : undefined)}
        style={
          swipeNavigable
            ? {
                transform: nav.offsetX ? `translateX(${nav.offsetX}px)` : undefined,
                transition: nav.settling ? undefined : "none",
              }
            : undefined
        }
      >
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
            <div className="reading-actions">
              {/* Prev/next are gone from this row entirely (#155): a
                touch-capable phone never had them here (#143 user story
                13 — swipe and Auto-advance carry the User on instead), and
                desktop's own copy moved out to `ReaderNeighborRail.tsx`, a
                floating rail beside the pane rather than a row of icons
                fighting the subject for space. `SplitView.tsx` is what
                renders that rail now; `onPrev`/`onNext` stay props here
                purely for `useSwipeToNavigate` below. */}

              {/* The Reply group (#289): a context-sensitive primary — Reply
                All when more than one other participant is on the Thread,
                else Reply (`replyMode`, `reading/reply-mode.ts`) — plus an
                overflow holding the reply form *not* showing inline and
                Forward. Rendered by hand rather than a generic loop since the
                inline button's icon/label depend on `replyMode`; the
                overflow itself is the shared `ReaderOverflowMenu`. */}
              <div className="reading-actions-group">
                <button
                  type="button"
                  onClick={() => {
                    if (replyTarget) onReply(replyTarget, replyMode);
                  }}
                  disabled={!replyTarget}
                  aria-label={replyMode === "replyAll" ? "Reply all" : "Reply"}
                  title={buttonTitle(
                    replyPrimaryId,
                    replyMode === "replyAll" ? "Reply all" : "Reply",
                  )}
                >
                  {replyMode === "replyAll" ? <ReplyAll size={15} /> : <Reply size={15} />}
                </button>
                <ReaderOverflowMenu
                  ctx={readerCtx}
                  actions={replyOverflowActions(readerCtx, replyPrimaryId)}
                  label={`More reply options for "${thread.subject || "(no subject)"}"`}
                />
              </div>

              <span className="reading-actions-gap" />

              {/* The Mail group (#289): Done, Snooze, Trash inline; Pin,
                Star, Label, Mark unread, Block and Spam in its overflow
                (`mailOverflowActions`), which additionally holds Approve
                whenever this Thread is under Screening Hold. Label still
                opens the same free-text Popover it always has (#43) — now
                anchored to the group itself rather than an inline button of
                its own, opened either by `L` (`openPicker`, unchanged) or by
                choosing "Label" from the overflow (`ReaderOverflowMenu`'s own
                `needsPicker` preference). */}
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverAnchor asChild>
                  <div className="reading-actions-group">
                    {mailPrimaryIds.has("done") ? (
                      <button
                        type="button"
                        data-act="done"
                        onClick={() => runReader("done", () => triage.archive(thread.id))}
                        aria-label="Done — archive this thread"
                        title={buttonTitle("done", "Done")}
                      >
                        <CheckCircle2 size={15} />
                      </button>
                    ) : null}
                    {mailPrimaryIds.has("snooze") ? (
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
                    ) : null}
                    {/* Trash keeps its distance and stays quiet until reached
                      for: in a triage app it is one keystroke away, so the
                      design owes it room rather than a red button in the
                      run. */}
                    {mailPrimaryIds.has("trash") ? (
                      <>
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
                      </>
                    ) : null}
                    <ReaderOverflowMenu
                      ctx={readerCtx}
                      actions={mailOverflowActions(readerCtx)}
                      label={`More actions for "${thread.subject || "(no subject)"}"`}
                    />
                  </div>
                </PopoverAnchor>
                <PopoverContent align="end" className="w-auto min-w-[220px] p-1.5">
                  <LabelPicker
                    thread={thread}
                    labels={labels}
                    triage={triage}
                    onClose={() => setPickerOpen(false)}
                  />
                </PopoverContent>
              </Popover>

              <span className="reading-actions-gap" />

              {/* Integrations (#289): one "Send to…" menu holding Add to
                Tasks and Save to Notes — the App's only bridges into the
                Tasks and Notes Apps, both menu-only since #289 (no inline
                buttons of their own any more). */}
              <div className="reading-actions-group">
                <ReaderOverflowMenu
                  ctx={readerCtx}
                  actions={sendToActions(readerCtx)}
                  label={`Send "${thread.subject || "(no subject)"}" to…`}
                  triggerClassName="reading-send-to"
                  trigger={
                    <>
                      <Send size={14} />
                      Send to…
                    </>
                  }
                />
              </div>
            </div>
          </div>
        </div>

        {/* #290: everything below the fixed action bar above — subject,
          participants, the Message list and the reply footer — is one
          scrolling document (`.reading-body`), not a mix of pinned chrome
          and a scrolled message list. Nothing here is sticky; the action
          bar above is the only chrome that stays put. */}
        <div className="reading-body">
          <div className="reading-heading">
            {groupLabel ? <div className="reading-eyebrow">{groupLabel}</div> : null}
            <h1 className="reading-subject">{thread.subject || "(no subject)"}</h1>
          </div>
          <div className="reading-meta">
            {primarySender ? (
              <SenderContactCard
                name={primarySender.name}
                address={primarySender.address}
                threadId={thread.id}
                avatarClassName="reading-avatar"
              />
            ) : (
              <Avatar name={participants} className="reading-avatar" />
            )}
            <span className="reading-identity">
              <span className="reading-from">{participants}</span>
              <span className="reading-addr">
                {thread.messageCount} message{thread.messageCount === 1 ? "" : "s"}
                {thread.labelIds.length > 0 ? (
                  <span className="reading-labels">
                    {thread.labelIds.map((id) => (
                      <span key={id} className="label-chip">
                        {labels.find((label) => label.id === id)?.name ?? labelNameForId(id)}
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

          <ReaderTaskChips threadId={thread.id} onOpenTask={onOpenTask} />
          {invitationCards?.map((card) => (
            <InviteCard key={card.uid} card={card} threadId={thread.id} />
          ))}

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

          {/* The comp's `.reply-hint`: the reply composer at rest — a quiet
            filled bar at the foot of the document that names who it would
            answer, rather than an empty editor holding the page open. Part
            of the scrolling document now (#290), not pinned above it. */}
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
      </div>
    </ActionMenu>
  );
}
