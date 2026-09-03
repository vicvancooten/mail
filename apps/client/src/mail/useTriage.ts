import type { AutoAdvanceDirection } from "@mail/shared";
import { useCallback, useEffect, useRef } from "react";
import { notifyTriageSucceeded } from "../pwa/notification-offer.js";
import type { CachedThread } from "../store/index.js";
import { enqueueMutation } from "../store/index.js";
import { neighborId } from "./thread-navigation.js";

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
 * - The keyboard scheme itself: `j`/`l` and the arrow keys all move the
 *   selection (no distinct "browse vs. open" step — Split view never had
 *   one, and List/Stream give it up here for one consistent model across
 *   all three, a deliberate trim vs. the prototype branch's per-view
 *   nuance); `e` archives, `#`/`Backspace`/`Delete` trashes, `s` toggles
 *   star — the prototype's own scheme (`prototype/triage-loop-ui`), plus
 *   the star shortcut it never needed (`Thread` there had no `starred`
 *   field). `p` toggles Pin (#43) — the prototype had no Pin either, so
 *   this is a fresh binding on the same scheme, chosen because `p`in is
 *   mnemonic and every other short letter near it is already spoken for.
 *
 *   `h` and `u` are reassigned by #79 (the Command Palette's Gmail/
 *   Superhuman vocabulary): `h` used to double as "previous" alongside `k`
 *   — dropped from movement here and rebound to Snooze
 *   (`ThreadDetailPane.tsx`'s own keydown listener, matching how `L` opens
 *   the Label picker). `u` used to toggle read/unread here — dropped from
 *   this hook's listener entirely and rebound to "back to list"
 *   (`ThreadDetailPane.tsx` again, calling its `onBack`); `toggleRead`
 *   itself is unchanged and stays reachable from the mouse (the Mark
 *   read/unread button) and the Command Palette, just with no bare-key
 *   binding of its own any more.
 *
 * `applyLabel`/`removeLabel` (#43) are one call each — no coalescing
 * decision to make here, `store/mutation-queue.ts` already owns that (apply
 * then remove of the same name while both are still queued cancels out).
 * Neither has a single-key binding here: which Label to apply is a name, not
 * a boolean, so it is reached through `LabelPicker`'s own input/list —
 * `ThreadDetailPane` owns that widget's open/close (its own `L` binding,
 * the same "one component, one window keydown listener" shape
 * `VirtualizedThreadList` already uses for `j`/`k`) and calls these two.
 */

export interface Triage {
  archive(threadId: string): void;
  trash(threadId: string): void;
  /** Snooze (#76): `until` is an ISO datetime, computed by the caller (`snooze-presets.ts`'s presets, or a custom pick) — this hook makes no time decisions of its own. */
  snooze(threadId: string, until: string): void;
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
  /**
   * True while the composer is open (#45, compose-spec §Composer surface &
   * keys: "the composer owns every key and the triage shortcuts are inert").
   * The actions themselves stay callable — only this hook's own `keydown`
   * listener goes quiet — so a mouse-driven triage action elsewhere is
   * unaffected.
   */
  shortcutsDisabled?: boolean;
}

export function useTriage({
  mailAccountId,
  threads,
  ids,
  selectedThreadId,
  onSelect,
  direction,
  autoAdvanceEnabled = true,
  shortcutsDisabled = false,
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

  const archive = useCallback(
    (threadId: string) => {
      advanceSelection(threadId); // before the enqueue: `ids` here still includes `threadId`
      const accountForThread = resolveMailAccountId(threadId);
      if (!accountForThread) return;
      void enqueueMutation({ type: "archive", threadId }, accountForThread);
      notifyTriageSucceeded();
    },
    [advanceSelection, resolveMailAccountId],
  );

  const trash = useCallback(
    (threadId: string) => {
      advanceSelection(threadId);
      const accountForThread = resolveMailAccountId(threadId);
      if (!accountForThread) return;
      void enqueueMutation({ type: "trash", threadId }, accountForThread);
      notifyTriageSucceeded();
    },
    [advanceSelection, resolveMailAccountId],
  );

  const snooze = useCallback(
    (threadId: string, until: string) => {
      advanceSelection(threadId); // same "leaves the Inbox" reasoning archive/trash's own comment gives
      const accountForThread = resolveMailAccountId(threadId);
      if (!accountForThread) return;
      void enqueueMutation({ type: "snooze", threadId, until }, accountForThread);
      notifyTriageSucceeded();
    },
    [advanceSelection, resolveMailAccountId],
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

  useEffect(() => {
    if (shortcutsDisabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;

      switch (event.key) {
        case "j":
        case "ArrowDown":
        case "l":
        case "ArrowRight": {
          event.preventDefault();
          const next = selectedThreadId ? neighborId(ids, selectedThreadId, 1) : (ids[0] ?? null);
          if (next) onSelect(next);
          return;
        }
        case "k":
        case "ArrowUp":
        case "ArrowLeft": {
          event.preventDefault();
          const prev = selectedThreadId ? neighborId(ids, selectedThreadId, -1) : (ids[0] ?? null);
          if (prev) onSelect(prev);
          return;
        }
        case "e":
          if (selectedThreadId) archive(selectedThreadId);
          return;
        case "#":
        case "Backspace":
        case "Delete":
          if (selectedThreadId) {
            event.preventDefault();
            trash(selectedThreadId);
          }
          return;
        case "s":
          if (selectedThreadId) toggleStar(selectedThreadId);
          return;
        case "p":
          if (selectedThreadId) togglePin(selectedThreadId);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [ids, selectedThreadId, onSelect, archive, trash, toggleStar, togglePin, shortcutsDisabled]);

  return { archive, trash, snooze, toggleStar, toggleRead, togglePin, applyLabel, removeLabel };
}
