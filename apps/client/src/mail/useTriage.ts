import type { AutoAdvanceDirection, GatekeeperSender } from "@mail/shared";
import { useCallback, useEffect, useRef } from "react";
import { notifyTriageSucceeded } from "../pwa/notification-offer.js";
import type { CachedThread } from "../store/index.js";
import { enqueueMutation } from "../store/index.js";
import { currentListHandle } from "./actions/surface-handles.js";
import { invalidateThreadMessages } from "./reading/useThreadMessages.js";
import { announceUndoableAction } from "./undo-toast.js";

/**
 * `advanceSelection`'s own fallback neighbor lookup (#275) for a caller with
 * no `VirtualizedThreadList` mounted to publish a collapse-aware
 * `ListHandle` — Stream mode (`stream/StreamStack.tsx`'s own doc comment:
 * "the point of that mode is not having a list"). Exactly the math the list
 * handle's own `neighborOf` runs, just over a flat id array with no
 * collapsed groups to skip.
 */
function flatNeighbor(
  ids: readonly string[],
  threadId: string,
  direction: AutoAdvanceDirection,
): string | null {
  const idx = ids.indexOf(threadId);
  if (idx === -1) return null;
  const older = ids[idx + 1] ?? null;
  const newer = idx > 0 ? (ids[idx - 1] ?? null) : null;
  return direction === "newer" ? (newer ?? older) : (older ?? newer);
}

/**
 * The one triage hook every view mode calls (#42, poc-spec.md §Triage &
 * views: "one shared `useTriage` hook so actions mean the same thing in
 * every view mode"). Owns three things, all keyboard- and mouse-reachable
 * alike:
 *
 * - The core actions — `archive`, `trash`, `snooze` (#76), `toggleStar`,
 *   `toggleRead` — each a single `enqueueMutation` call (ADR-0010's overlay
 *   does the rest: `store/reads.ts` is what a Thread disappearing or its
 *   star flipping actually renders from, not anything returned here).
 *   `archive`/`trash`/`snooze` are also the three undoable actions this hook
 *   owns (#95, ADR-0019 — Block/Deny are the other two, undone from
 *   `screener/Screener.tsx` instead): each returns its own Undo handle — a
 *   thunk that enqueues the exact inverse intent (`restoreToInbox`/
 *   `unsnooze`) — and hands it to `undo-toast.ts#announceUndoableAction`,
 *   which raises or coalesces the toast. Star/Pin/Read/Label already toggle,
 *   so they raise no toast and keep returning `void`.
 * - Auto-advance: archiving/trashing/snoozing the *currently selected*
 *   Thread moves the selection to its neighbor first — computed before the
 *   Thread vanishes from the list, never after — per `direction`. Archiving
 *   a Thread that isn't selected (a future multi-select, a mouse action on a
 *   row you're not reading) leaves the selection alone, matching an ordinary
 *   mail client. The neighbor itself comes from the mounted list's own
 *   collapse-aware order (`actions/surface-handles.ts#ListHandle.neighborOf`,
 *   #275) — the same mover `j`/`k` already use, so a collapsed Time Group
 *   (#78) is skipped by Auto-advance too — falling back to a flat `ids` scan
 *   (`flatNeighbor` below) only where no list is mounted to ask (Stream).
 *   Auto-advance also re-homes DOM focus onto whatever it lands on
 *   (`ListHandle.focusThread`), or the listbox itself once nothing does, so
 *   the next keypress after a Triage action needs no click first.
 *   `selectedThreadId`/`ids` are read through refs here, not the render-time
 *   props of the same name (`selectedThreadIdRef`/`idsRef` below): two
 *   Triage actions dispatched before React re-renders once between them —
 *   two quick Dones — would otherwise both compute their neighbor against
 *   the *same* stale selection, landing one Thread short of where both
 *   should end up.
 * - Mark-as-read on open: selecting any unread Thread, by any means,
 *   queues `setRead(true)` for it. Read via a ref so it fires once per
 *   *selection change* — depending on `threads` directly would refire (and
 *   redundantly re-enqueue) on every unrelated overlay recompute.
 *
 * What it deliberately no longer owns is **the keyboard** (#94): every
 * binding in the Client now lives in one place, `actions/registry.ts`, read
 * by the single `keydown` listener in `actions/ActionsProvider.tsx`. This
 * hook used to carry its own listener for `e`/`#`/`s`/`p` and `j`/`k`
 * movement, one of four that between them re-stated the same scheme in four
 * files; the actions below are what that one listener calls, and are equally
 * what the row cluster, the reader toolbar, the Command Palette and the
 * right-click menu call. Nothing about the mutations themselves changed.
 *
 * `applyLabel`/`removeLabel` (#43) are one call each — no coalescing
 * decision to make here, `store/mutation-queue.ts` already owns that (apply
 * then remove of the same name while both are still queued cancels out).
 * Neither has a single-key binding here: which Label to apply is a name, not
 * a boolean, so it is reached through `LabelPicker`'s own input/list —
 * the registry's `label` action opens that widget (`ThreadDetailPane`'s own
 * Popover) rather than committing anything itself, and the picker calls
 * these two.
 *
 * `spamSender`/`blockSender`/`approveSender` (#144, epic #133's "Gatekeeper set on
 * Inbox Threads") put the Screener's own three decisions on any Inbox
 * Thread: the row menu, the Reader's More menu, and — Spam alone — the
 * keyboard (`!`). Each resolves *which* sender it's deciding about the same
 * way the Sync Backend does (the Thread's own opener, `thread.participants[0]`
 * — oldest `From` first, `sync/thread-rollup.ts#collectParticipants`'s own
 * order) and rides the exact same `approveSender`/`blockSender`/`spamSender`
 * intents the Screener uses, just carrying this one Thread's id alongside
 * the sender so the Sync Backend also moves *this* Thread even though it was
 * never held (`gatekeeper/decisions.ts`'s own doc comment). All three work
 * whether or not Gatekeeper is even on for the Mail Account — the Verdict is
 * recorded either way and takes effect if it's turned on later. Spam and
 * Block are undoable (#95, ADR-0019) the same shape `archive`/`trash` are —
 * `unblockAndRestore` is the real inverse, clearing the Verdict and
 * restoring the Thread; Approve's own inverse is `unblockSender`, which
 * clears the Verdict back to Unscreened without touching the Thread (there
 * is nothing to restore — Approve never moved it). This is a genuine
 * departure from the Screener's own Approve, which announces no toast at all
 * (CONTEXT.md's Undo entry doesn't list it, and releasing a stranger's mail
 * needs no second thoughts the way trashing it does) — here, Approve is
 * un-approving an Inbox Thread the User is looking at, which is exactly the
 * kind of second thought Undo exists for.
 */

export interface Triage {
  /** Returns the Undo handle (#95, ADR-0019): calling it enqueues `restoreToInbox`, the exact inverse. */
  archive(threadId: string): () => void;
  /** Returns the Undo handle, same shape as `archive` — also `restoreToInbox`, Trash and Done sharing one inverse. */
  trash(threadId: string): () => void;
  /**
   * Snooze (#76): `until` is an ISO datetime, computed by the caller
   * (`snooze-presets.ts`'s presets, or a custom pick) — this hook makes no
   * time decisions of its own. Returns the Undo handle (#95): calling it
   * enqueues `unsnooze`.
   */
  snooze(threadId: string, until: string): () => void;
  toggleStar(threadId: string): void;
  toggleRead(threadId: string): void;
  togglePin(threadId: string): void;
  applyLabel(threadId: string, name: string): void;
  removeLabel(threadId: string, name: string): void;
  /**
   * Spam (#144, `!`): records a Blocked Verdict (`spam: true`) for this
   * Thread's own sender and moves the Thread to the Mail Account's Junk
   * Folder. Returns the Undo handle (#95): calling it enqueues
   * `unblockAndRestore`, clearing the Verdict and restoring the Thread.
   */
  spamSender(threadId: string): () => void;
  /** Block (#144): the same shape as `spamSender`, to Trash instead of Junk. */
  blockSender(threadId: string): () => void;
  /**
   * Approve (#144): records an Approved Verdict for this Thread's own
   * sender — nothing moves, since an Inbox Thread was never held. Returns
   * the Undo handle (#95): calling it enqueues `unblockSender`, clearing the
   * Verdict back to Unscreened.
   */
  approveSender(threadId: string): () => void;
}

export interface UseTriageOptions {
  mailAccountId: string | null;
  /** Newest-first, matching `useThreadWindow` — what "older"/"newer" below means. */
  threads: readonly CachedThread[];
  ids: readonly string[];
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  direction: AutoAdvanceDirection;
  /** Auto-advance on/off (#54, poc-spec.md §Preferences) — `false` leaves the selection where it was after archive/trash. */
  autoAdvanceEnabled?: boolean;
}

export function useTriage({
  mailAccountId,
  threads,
  ids,
  selectedThreadId,
  onSelect,
  direction,
  autoAdvanceEnabled = true,
}: UseTriageOptions): Triage {
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  // #275: mirrors of the two render-time props `advanceSelection` used to
  // read directly — reassigned on every render, same as `threadsRef` above,
  // *and* written imperatively inside `advanceSelection` itself the instant
  // it moves the selection, so a second Triage call in the same tick (no
  // re-render in between) sees the just-advanced-to id rather than the
  // stale prop. Without that second write, two quick Dones would both
  // compute their neighbor off the Thread that was selected *before either
  // ran*, landing the final selection one Thread short.
  const selectedThreadIdRef = useRef(selectedThreadId);
  selectedThreadIdRef.current = selectedThreadId;
  const idsRef = useRef(ids);
  idsRef.current = ids;

  /**
   * Cross-account results (#80: "Triage from a cross-account result acts on
   * the right Mail Account"): `threads` can hold rows from more than one
   * in-scope account once a search spans Account Scope, so every mutation
   * below resolves the account off the Thread it is actually acting on
   * (already on every `CachedThread`, `sync.ts#threadSchema`) rather than
   * always enqueueing under the base `mailAccountId` this hook was given —
   * that base stays the fallback for a `threadId` this hook hasn't seen yet
   * (a click that outraces `threads` catching up).
   */
  const resolveMailAccountId = useCallback(
    (threadId: string): string | null =>
      threadsRef.current.find((thread) => thread.id === threadId)?.mailAccountId ?? mailAccountId,
    [mailAccountId],
  );

  // Mark-as-read on open: fires once per selection change, never on an
  // unrelated re-render that merely changed `threads`' identity (an
  // already-applied setRead(true) is a no-op the coalescer can't catch,
  // since there is no `setRead(false)` sitting in the queue to cancel it
  // against — `unreadCount === 0` is the real guard).
  useEffect(() => {
    if (!selectedThreadId) return;
    const thread = threadsRef.current.find((t) => t.id === selectedThreadId);
    const accountForThread = resolveMailAccountId(selectedThreadId);
    if (thread && accountForThread && thread.unreadCount > 0) {
      void enqueueMutation(
        { type: "setRead", threadId: selectedThreadId, read: true },
        accountForThread,
      );
    }
  }, [selectedThreadId, resolveMailAccountId]);

  /** Moves the selection off `threadId` onto its `direction`-preferred neighbor, only if it was selected. */
  const advanceSelection = useCallback(
    (threadId: string) => {
      if (!autoAdvanceEnabled || selectedThreadIdRef.current !== threadId) return;
      const list = currentListHandle();
      const upcoming = list
        ? list.neighborOf(threadId, direction)
        : flatNeighbor(idsRef.current, threadId, direction);
      // Written before `onSelect` fires (#275's own doc comment above) so a
      // second `advanceSelection` call in this same tick — a second Done
      // dispatched before React re-renders once — reads *this* call's
      // result rather than the stale `threadId` it started from.
      selectedThreadIdRef.current = upcoming;
      if (upcoming) onSelect(upcoming);
      list?.focusThread(upcoming);
    },
    [direction, autoAdvanceEnabled, onSelect],
  );

  /** A handle with nothing to undo — the "couldn't even resolve an account" branch below, which never enqueued the forward action either. */
  const noopUndo = useCallback(() => {}, []);

  const archive = useCallback(
    (threadId: string): (() => void) => {
      advanceSelection(threadId); // before the enqueue: `ids` here still includes `threadId`
      const accountForThread = resolveMailAccountId(threadId);
      if (!accountForThread) return noopUndo;
      void enqueueMutation({ type: "archive", threadId }, accountForThread);
      notifyTriageSucceeded();
      // Undo (#95, ADR-0019): the real inverse, not a queue cancellation —
      // works whether or not the archive above has already flushed.
      const undo = () => {
        void enqueueMutation({ type: "restoreToInbox", threadId }, accountForThread);
      };
      announceUndoableAction("done", undo);
      return undo;
    },
    [advanceSelection, resolveMailAccountId, noopUndo],
  );

  const trash = useCallback(
    (threadId: string): (() => void) => {
      advanceSelection(threadId);
      const accountForThread = resolveMailAccountId(threadId);
      if (!accountForThread) return noopUndo;
      void enqueueMutation({ type: "trash", threadId }, accountForThread);
      notifyTriageSucceeded();
      const undo = () => {
        void enqueueMutation({ type: "restoreToInbox", threadId }, accountForThread);
      };
      announceUndoableAction("trash", undo);
      return undo;
    },
    [advanceSelection, resolveMailAccountId, noopUndo],
  );

  const snooze = useCallback(
    (threadId: string, until: string): (() => void) => {
      advanceSelection(threadId); // same "leaves the Inbox" reasoning archive/trash's own comment gives
      const accountForThread = resolveMailAccountId(threadId);
      if (!accountForThread) return noopUndo;
      void enqueueMutation({ type: "snooze", threadId, until }, accountForThread);
      notifyTriageSucceeded();
      const undo = () => {
        void enqueueMutation({ type: "unsnooze", threadId }, accountForThread);
      };
      announceUndoableAction("snooze", undo);
      return undo;
    },
    [advanceSelection, resolveMailAccountId, noopUndo],
  );

  /**
   * The Thread's own sender (#144): the opener's `From`, oldest-first same
   * as `participants` (`sync/thread-rollup.ts#collectParticipants`'s own
   * order) — exactly what the Sync Backend resolves a Thread's sender to
   * when it isn't held (`gatekeeper/decisions.ts`'s own doc comment). `null`
   * for a Thread this hook hasn't seen yet, or one with no `From` at all —
   * there is nothing to screen.
   */
  const resolveThreadSender = useCallback(
    (threadId: string): { accountId: string; sender: GatekeeperSender } | null => {
      const thread = threadsRef.current.find((t) => t.id === threadId);
      const accountId = resolveMailAccountId(threadId);
      const address = thread?.participants[0]?.address;
      if (!accountId || !address) return null;
      return { accountId, sender: { scope: "address", value: address } };
    },
    [resolveMailAccountId],
  );

  const spamSender = useCallback(
    (threadId: string): (() => void) => {
      const resolved = resolveThreadSender(threadId);
      if (!resolved) return noopUndo;
      const { accountId, sender } = resolved;
      advanceSelection(threadId); // leaves the Inbox, same as trash
      void enqueueMutation({ type: "spamSender", sender, threadId }, accountId);
      // Spam records a Blocked Verdict same as Block below — the same
      // staleness `approveSender`'s own invalidation (and
      // `screener/Screener.tsx#decide`'s, #145) fixes there applies here too.
      invalidateThreadMessages([threadId]);
      notifyTriageSucceeded();
      const undo = () => {
        void enqueueMutation(
          { type: "unblockAndRestore", sender, threadIds: [threadId] },
          accountId,
        );
        invalidateThreadMessages([threadId]);
      };
      announceUndoableAction("spam", undo);
      return undo;
    },
    [advanceSelection, resolveThreadSender, noopUndo],
  );

  const blockSender = useCallback(
    (threadId: string): (() => void) => {
      const resolved = resolveThreadSender(threadId);
      if (!resolved) return noopUndo;
      const { accountId, sender } = resolved;
      advanceSelection(threadId);
      void enqueueMutation({ type: "blockSender", sender, threadId }, accountId);
      // Block records a Blocked Verdict too — same staleness, same fix
      // (`approveSender`'s own invalidation, `screener/Screener.tsx#decide`).
      invalidateThreadMessages([threadId]);
      notifyTriageSucceeded();
      const undo = () => {
        void enqueueMutation(
          { type: "unblockAndRestore", sender, threadIds: [threadId] },
          accountId,
        );
        invalidateThreadMessages([threadId]);
      };
      announceUndoableAction("block", undo);
      return undo;
    },
    [advanceSelection, resolveThreadSender, noopUndo],
  );

  const approveSender = useCallback(
    (threadId: string): (() => void) => {
      const resolved = resolveThreadSender(threadId);
      if (!resolved) return noopUndo;
      const { accountId, sender } = resolved;
      // Approve never moves the Thread — no `advanceSelection` — but it does
      // change what `remoteImagesAllowed` resolves to on the next open, the
      // same staleness `screener/Screener.tsx#decide` (#145) fixes there.
      void enqueueMutation({ type: "approveSender", sender, threadId }, accountId);
      invalidateThreadMessages([threadId]);
      notifyTriageSucceeded();
      const undo = () => {
        void enqueueMutation({ type: "unblockSender", sender }, accountId);
        invalidateThreadMessages([threadId]);
      };
      announceUndoableAction("approve", undo);
      return undo;
    },
    [resolveThreadSender, noopUndo],
  );

  const toggleStar = useCallback(
    (threadId: string) => {
      const accountForThread = resolveMailAccountId(threadId);
      if (!accountForThread) return;
      const thread = threadsRef.current.find((t) => t.id === threadId);
      if (!thread) return;
      void enqueueMutation(
        { type: "setStarred", threadId, starred: !thread.starred },
        accountForThread,
      );
      notifyTriageSucceeded();
    },
    [resolveMailAccountId],
  );

  const toggleRead = useCallback(
    (threadId: string) => {
      const accountForThread = resolveMailAccountId(threadId);
      if (!accountForThread) return;
      const thread = threadsRef.current.find((t) => t.id === threadId);
      if (!thread) return;
      void enqueueMutation(
        { type: "setRead", threadId, read: thread.unreadCount > 0 },
        accountForThread,
      );
      notifyTriageSucceeded();
    },
    [resolveMailAccountId],
  );

  const togglePin = useCallback(
    (threadId: string) => {
      const accountForThread = resolveMailAccountId(threadId);
      if (!accountForThread) return;
      const thread = threadsRef.current.find((t) => t.id === threadId);
      if (!thread) return;
      void enqueueMutation(
        { type: "setPinned", threadId, pinned: !thread.pinned },
        accountForThread,
      );
    },
    [resolveMailAccountId],
  );

  const applyLabel = useCallback(
    (threadId: string, name: string) => {
      const accountForThread = resolveMailAccountId(threadId);
      if (!accountForThread) return;
      void enqueueMutation({ type: "applyLabel", threadId, name }, accountForThread);
    },
    [resolveMailAccountId],
  );

  const removeLabel = useCallback(
    (threadId: string, name: string) => {
      const accountForThread = resolveMailAccountId(threadId);
      if (!accountForThread) return;
      void enqueueMutation({ type: "removeLabel", threadId, name }, accountForThread);
    },
    [resolveMailAccountId],
  );

  return {
    archive,
    trash,
    snooze,
    toggleStar,
    toggleRead,
    togglePin,
    applyLabel,
    removeLabel,
    spamSender,
    blockSender,
    approveSender,
  };
}
