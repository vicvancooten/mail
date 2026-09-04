/**
 * What the currently mounted surfaces let the registry reach (#94).
 *
 * Two things the Action registry needs are owned by components far below
 * the one place the single `keydown` listener can live: which Message the
 * reader has scrolled to (its reply target) plus its two picker Popovers,
 * and the list's own collapse-aware selection mover. Rather than thread two
 * more props through `SplitView`/`ListView`/`SearchResultsView`/`stream/StreamStack`,
 * the mounted surface publishes a small handle here and clears it on
 * unmount — the same module-level channel shape `command-palette/global-open.ts`
 * and `pwa/notification-router.ts` already use.
 *
 * At most one of each is ever mounted (one reader, one list), and a
 * publisher only clears the handle if it is still its own, so a remount
 * that races an unmount can't blank a live surface.
 */

import type { Message } from "@mail/shared";

export interface ReaderHandle {
  /** The Message `r`/`a`/`f` act on — whichever one the reader reports as open, defaulting to the newest. */
  replyTarget: Message | null;
  /** Opens the reader toolbar's own Snooze or Label Popover. */
  openPicker: (which: "snooze" | "label") => void;
  /** "Back to list", where the reader's host has a list to return to. */
  onBack?: () => void;
}

export interface ListHandle {
  /** Moves the selection one row, skipping collapsed groups and scrolling the new row into view (#78). */
  move: (delta: 1 | -1) => void;
}

let reader: ReaderHandle | null = null;
let list: ListHandle | null = null;

export function publishReaderHandle(handle: ReaderHandle): () => void {
  reader = handle;
  return () => {
    if (reader === handle) reader = null;
  };
}

export function currentReaderHandle(): ReaderHandle | null {
  return reader;
}

export function publishListHandle(handle: ListHandle): () => void {
  list = handle;
  return () => {
    if (list === handle) list = null;
  };
}

export function currentListHandle(): ListHandle | null {
  return list;
}

/** Test-only: drops both handles, so one test's mounted surfaces never leak into the next. */
export function resetSurfaceHandles(): void {
  reader = null;
  list = null;
}
