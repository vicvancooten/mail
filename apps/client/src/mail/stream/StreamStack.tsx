import type { MailAccount, Message } from "@mail/shared";
import { CheckCircle2, SkipForward, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildReplyContent, type ReplyMode } from "../../compose/reply.js";
import type { CachedThread } from "../../store/index.js";
import {
  EMPTY_COMPOSE_CONTENT,
  newCompositionId,
  saveComposition,
  THREAD_PAGE_SIZE,
  useLabels,
  useMailAccounts,
  useThreadWindow,
} from "../../store/index.js";
import { useLocalCacheSync } from "../../sync/use-local-cache-sync.js";
import { ActionsProvider, useActionKeyboard } from "../actions/ActionsProvider.js";
import { currentReaderHandle } from "../actions/surface-handles.js";
import type { ActionContext } from "../actions/types.js";
import { ShortcutSheet } from "../command-palette/ShortcutSheet.js";
import { folderToView } from "../folders.js";
import { RollbackToast } from "../RollbackToast.js";
import type { MailtoLink } from "../reading/mailto.js";
import { useThreadMessages } from "../reading/useThreadMessages.js";
import { ThreadDetailPane } from "../ThreadDetailPane.js";
import { findThread, neighborId } from "../thread-navigation.js";
import { PINNED_GROUP_LABEL, timeGroupLabel } from "../time-groups.js";
import { useAccountScope } from "../useAccountScope.js";
import { useTriage } from "../useTriage.js";
import "./stream.css";

const Composer = lazy(() =>
  import("../../compose/Composer.js").then((m) => ({ default: m.Composer })),
);

/** How many loaded cards to keep ahead of the top of the stack before asking `useThreadWindow` for more — a buffer, not "load everything up front" (an Inbox can hold thousands). */
const LOAD_BUFFER = 5;

/** Matches `mail.css`'s `--dur-leave` (260ms) — the Arrive-Silent, Leave-Visibly Rule's own leave duration (`DESIGN.md`'s Motion section), same fixed-constant posture `MailSection.tsx`'s `GROUP_COLLAPSE_DURATION_MS` already takes rather than reading the CSS variable back out. */
const STREAM_LEAVE_MS = 260;

/** Never a real Thread id (ULIDs never start with a NUL) — what `skip` selects when there is no next card, so the same "selection points at nothing `useThreadWindow` has" plumbing that already renders the ending state after the last Triage action handles "skipped past the last card" too. */
const STREAM_ENDED_ID = "__stream-ended";

/**
 * Stream (#105, CONTEXT.md): "processing the Inbox one Thread at a time,
 * full screen, as a stack of cards ... entered deliberately from Mail, ends
 * when the stack is empty or the User leaves." Its own route
 * (`router/routes.tsx#streamRoute`) rather than a Device Preference toggle
 * over Split/List — the retired `mail/StreamView.tsx` was that toggle, one
 * Thread with a peek strip; this is a destination, unlike search (ADR-0017's
 * test), so reload restores it.
 *
 * The stack itself is every Inbox Thread in the current Account Scope
 * (`useAccountScope`, the same device-local scope Mail's own toolbar reads),
 * newest first — `folderToView("inbox")` already excludes Screening Holds
 * (`store/reads.ts`'s own doc comment), so held mail is never in the stack.
 * `topId` is "whose card is on top" and `activeId` is `useTriage`'s own
 * selection: the two start equal and only ever diverge for the
 * `STREAM_LEAVE_MS` window a Triage action or Skip is animating out, which
 * is what lets the outgoing card keep rendering its last-known content
 * (`topThreadSnapshot`, frozen while `leavingId` is set) even though the
 * Local Cache's optimistic overlay (ADR-0010) has already dropped it from
 * `threads`. The next card, found the same way (`neighborId`), peeks out
 * from behind — no entrance animation once it becomes `topId` (Arrive-
 * Silent), the outgoing card gets one (Leave-Visibly), per `DESIGN.md`'s
 * Motion section.
 *
 * Skip (`streamSkip` on the Action registry's context, `n`) moves the stack
 * on the same way an action does — set `activeId` to the next id — without
 * calling `triage` at all, so the Thread stays exactly where it was in the
 * Inbox. Reply is Done *plus* the Composer (CONTEXT.md's own wording): the
 * stack has already advanced by the time the Composer mounts, whether or
 * not the User ever sends.
 *
 * `j`/`k` next/prev stay unavailable here (`threadCount: 0` in the
 * registry's context) — Stream is a one-way stack to drain, not a list to
 * browse, and Skip is the one way to move on without acting.
 */
export function StreamStack({ onLeave }: { onLeave: () => void }) {
  useLocalCacheSync();
  const mailAccounts = useMailAccounts();
  const { scope: accountScope } = useAccountScope(mailAccounts);
  const accountId = accountScope[0] ?? null;
  const labels = useLabels() ?? [];

  const [limit, setLimit] = useState(THREAD_PAGE_SIZE);
  const page = useThreadWindow(accountScope, { view: folderToView("inbox"), limit });
  const threads = useMemo(() => page?.threads ?? [], [page]);
  const ids = useMemo(() => threads.map((thread) => thread.id), [threads]);

  useEffect(() => {
    if (page && !page.complete && ids.length < LOAD_BUFFER) {
      setLimit((current) => current + THREAD_PAGE_SIZE);
    }
  }, [page, ids.length]);

  // `activeId` is `useTriage`'s own selection — what Done/Trash/Snooze
  // advance and what Skip sets directly. `topId` is what's actually
  // rendered; see the module doc comment for why the two can differ for a
  // moment.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [topId, setTopId] = useState<string | null>(null);
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const [topThreadSnapshot, setTopThreadSnapshot] = useState<CachedThread | null>(null);

  // Seeds both ids to the newest Thread once the window has one — a fresh
  // Stream session, or an Inbox that was empty on mount and just synced its
  // first Thread in.
  useEffect(() => {
    const newest = ids[0] ?? null;
    if (topId === null && newest !== null) {
      setTopId(newest);
      setActiveId(newest);
    }
  }, [topId, ids]);

  // Frozen the instant a leave starts (see module doc comment) — otherwise
  // the optimistic overlay dropping the Thread from `threads` would blank
  // the very card that's supposed to still be animating off screen.
  useEffect(() => {
    if (leavingId !== null) return;
    setTopThreadSnapshot(topId ? findThread(threads, topId) : null);
  }, [threads, topId, leavingId]);

  // The divergence detector: once a Triage action or Skip has moved
  // `activeId` on, the card in `topId` gets its leave animation, then
  // `topId` catches up — arriving with none of its own (Arrive-Silent).
  // `leavingRef`, not `leavingId` itself, gates re-entry: `leavingId` is
  // state this effect also *writes*, and depending on it here would have
  // React tear the just-scheduled timer back down the instant that write's
  // own re-render ran this effect again — the leave would start and
  // immediately cancel itself, forever.
  const leavingRef = useRef(false);
  useEffect(() => {
    if (activeId === topId || leavingRef.current) return;
    leavingRef.current = true;
    setLeavingId(topId);
    const timer = setTimeout(() => {
      setTopId(activeId);
      setLeavingId(null);
      leavingRef.current = false;
    }, STREAM_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [activeId, topId]);

  const triage = useTriage({
    mailAccountId: accountId,
    threads,
    ids,
    selectedThreadId: activeId,
    onSelect: setActiveId,
    // Always forward through the stack, regardless of the User's
    // auto-advance Preference (Settings' own General section) — that
    // Preference is about which neighbor Split/List leaves you on, while
    // Stream's whole shape is "one Thread at a time, moving on" (CONTEXT.md).
    direction: "older",
  });

  // Off `activeId` — the logical position — not `topId`, which can still be
  // mid-leave when Skip is pressed again in quick succession: basing this on
  // the visual card would recompute the same neighbor twice and strand the
  // second press.
  const skip = useCallback(() => {
    if (activeId === null) return;
    setActiveId(neighborId(ids, activeId, 1) ?? STREAM_ENDED_ID);
  }, [activeId, ids]);

  const nextThread = topId ? findThread(threads, neighborId(ids, topId, 1)) : null;
  const { messages } = useThreadMessages(topThreadSnapshot?.id ?? "");

  const [composeId, setComposeId] = useState<string | null>(null);
  const [composeFromChoices, setComposeFromChoices] = useState<MailAccount[] | null>(null);
  const closeCompose = useCallback(() => setComposeId(null), []);

  const openCompose = useCallback(() => {
    if (composeId !== null || !accountId || !mailAccounts) return;
    setComposeFromChoices(
      accountScope.length > 1
        ? mailAccounts.filter((account) => accountScope.includes(account.id))
        : null,
    );
    setComposeId(newCompositionId());
  }, [composeId, accountId, accountScope, mailAccounts]);

  // Reply = Done + the Composer over the stack (CONTEXT.md's Stream): the
  // Thread named by `topId` when the reply was raised is what Dones, not
  // whatever `topId` happens to be once the User finishes typing.
  const openReply = useCallback(
    (message: Message, mode: ReplyMode) => {
      if (composeId !== null || !mailAccounts) return;
      const account = mailAccounts.find((candidate) => candidate.id === message.mailAccountId);
      if (!account) return;
      const doneThreadId = topId;
      const id = newCompositionId();
      setComposeFromChoices(null);
      if (doneThreadId) triage.archive(doneThreadId);
      void saveComposition(id, account.id, buildReplyContent(mode, message, account), {
        force: true,
      }).then(() => setComposeId(id));
    },
    [composeId, mailAccounts, topId, triage],
  );

  const openMailtoLink = useCallback(
    (link: MailtoLink) => {
      if (composeId !== null || !mailAccounts || !accountId) return;
      setComposeFromChoices(
        accountScope.length > 1
          ? mailAccounts.filter((account) => accountScope.includes(account.id))
          : null,
      );
      const id = newCompositionId();
      void saveComposition(
        id,
        accountId,
        { ...EMPTY_COMPOSE_CONTENT, to: link.to, subject: link.subject ?? "" },
        { force: true },
      ).then(() => setComposeId(id));
    },
    [composeId, mailAccounts, accountId, accountScope],
  );

  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false);

  // Esc/Close is "one action, loses nothing" (#105's acceptance criteria) —
  // inert while the composer or the Shortcut Sheet owns the keyboard, same
  // posture `MailSection`'s own listener takes.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && composeId === null && !shortcutSheetOpen) onLeave();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onLeave, composeId, shortcutSheetOpen]);

  const actionContext = useMemo<ActionContext>(
    () => ({
      thread: topThreadSnapshot,
      triage,
      latestMessage: messages?.at(-1) ?? null,
      labels,
      onReply: openReply,
      onCompose: openCompose,
      onBackToList: onLeave,
      onOpenScreener: () => {},
      screenerCount: 0,
      onFocusSearch: () => {},
      onOpenPalette: () => {},
      onOpenShortcutSheet: () => setShortcutSheetOpen(true),
      onOpenStream: () => {},
      onMove: () => {},
      threadCount: 0,
      openPicker: topThreadSnapshot ? (which) => currentReaderHandle()?.openPicker(which) : null,
      group: null,
      screenerSender: null,
      draft: null,
      streamSkip: topThreadSnapshot ? skip : null,
    }),
    [topThreadSnapshot, triage, messages, labels, openReply, openCompose, onLeave, skip],
  );

  useActionKeyboard(actionContext, composeId !== null || shortcutSheetOpen);

  if (!mailAccounts || mailAccounts.length === 0) return null;
  if (!page) return null;

  const leaving = leavingId !== null && leavingId === topId;

  return (
    <ActionsProvider value={actionContext}>
      <div className="stream-route">
        <header className="stream-topbar">
          <button
            type="button"
            className="stream-close"
            onClick={onLeave}
            aria-label="Close Stream"
          >
            <X size={16} />
          </button>
          <div className="stream-progress tabular">{ids.length} in Stream</div>
        </header>
        <div className="stream-cards">
          {nextThread ? (
            <div className="stream-card stream-card-peek" aria-hidden="true">
              <span className="stream-card-peek-subject">
                {nextThread.subject || "(no subject)"}
              </span>
            </div>
          ) : null}
          {topThreadSnapshot ? (
            <div
              className={`stream-card stream-card-top${leaving ? " leaving" : ""}`}
              key={topThreadSnapshot.id}
            >
              <ThreadDetailPane
                thread={topThreadSnapshot}
                groupLabel={
                  topThreadSnapshot.pinned
                    ? PINNED_GROUP_LABEL
                    : timeGroupLabel(
                        topThreadSnapshot.lastMessageAt ?? topThreadSnapshot.firstMessageAt,
                      )
                }
                triage={triage}
                onReply={openReply}
                onMailtoLink={openMailtoLink}
              />
              <button type="button" className="stream-skip" onClick={skip}>
                <SkipForward size={15} />
                Skip
              </button>
            </div>
          ) : (
            <div className="stream-empty">
              <CheckCircle2 size={28} />
              <h2>Stream cleared</h2>
              <p>Nothing left to process here — back to Mail whenever you're ready.</p>
              <button type="button" className="stream-empty-back" onClick={onLeave}>
                Back to Mail
              </button>
            </div>
          )}
        </div>
        <RollbackToast />
        <ShortcutSheet open={shortcutSheetOpen} onClose={() => setShortcutSheetOpen(false)} />
        {composeId && accountId ? (
          <Suspense fallback={null}>
            <Composer
              key={composeId}
              compositionId={composeId}
              mailAccounts={mailAccounts}
              defaultMailAccountId={accountId}
              fromChoices={composeFromChoices}
              onClose={closeCompose}
            />
          </Suspense>
        ) : null}
      </div>
    </ActionsProvider>
  );
}
