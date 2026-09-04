import type { AutoAdvanceDirection } from "@mail/shared";
import { useCallback, useEffect, useRef } from "react";
import { notifyTriageSucceeded } from "../pwa/notification-offer.js";
import type { CachedThread } from "../store/index.js";
import { enqueueMutation } from "../store/index.js";
import { announceUndoableAction } from "./undo-toast.js";

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
 *   Thread moves the selection to its neighbor first — computed from `ids`
 *   before the Thread vanishes from it, never after — per `direction`.
 *   Archiving a Thread that isn't selected (a future multi-select, a mouse
 *   action on a row you're not reading) leaves the selection alone, matching
 *   an ordinary mail client.
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
      if (!autoAdvanceEnabled || selectedThreadId !== threadId) return;
      const idx = ids.indexOf(threadId);
      if (idx === -1) return;
      const older = ids[idx + 1] ?? null;
      const newer = idx > 0 ? (ids[idx - 1] ?? null) : null;
      const upcoming = direction === "newer" ? (newer ?? older) : (older ?? newer);
      if (upcoming) onSelect(upcoming);
    },
    [ids, selectedThreadId, direction, autoAdvanceEnabled, onSelect],
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

  return { archive, trash, snooze, toggleStar, toggleRead, togglePin, applyLabel, removeLabel };
}
