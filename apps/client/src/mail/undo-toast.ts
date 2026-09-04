import { BULK_TRIAGE_UNDO_WINDOW_SECONDS } from "@mail/shared";
import { dismissActionToast, raiseActionToast } from "./action-toast.js";

/**
 * Coalesced Undo toasts for the ordinary Triage/Screener/Compose actions
 * (#95, ADR-0019, CONTEXT.md's own Undo entry: "actions taken in quick
 * succession share one toast and one Undo"). `useTriage.ts`'s `archive`/
 * `trash`/`snooze`, `screener/Screener.tsx`'s Deny/Block decisions, and
 * `compose/Composer.tsx`'s explicit Discard (#101) each call
 * `announceUndoableAction` right after enqueueing the forward Optimistic
 * Action — Approve/Star/Pin/Read/Label never do, matching #95's own list of
 * what's undoable, and neither does a Draft that discards silently on close
 * with no content (`Composer.tsx`'s own doc comment).
 *
 * Pressing `e` eight times fast raises one toast, "8 done · Undo", not
 * eight — every call within `BULK_TRIAGE_UNDO_WINDOW_SECONDS` of the last
 * one for that *kind* folds into the same bucket, its window sliding
 * forward each time, and its single Undo button reverses every action
 * folded in. Mixed kinds (a Done next to a Trash) each get their own toast,
 * but at most `MAX_STACKED_TOASTS` show at once — a third kind evicts the
 * *toast* for the oldest still-open kind, not its Undo opportunity: the
 * bucket keeps counting inside its own window, so a same-kind action
 * arriving before it expires still reaches the right Undo, just without a
 * visible toast to click in the meantime.
 */

export type UndoableActionKind = "done" | "trash" | "snooze" | "block" | "deny" | "discard";

const WINDOW_MS = BULK_TRIAGE_UNDO_WINDOW_SECONDS * 1000;
const MAX_STACKED_TOASTS = 2;

const LABELS: Record<UndoableActionKind, { one: string; many: (count: number) => string }> = {
  done: { one: "Done", many: (count) => `${count} done` },
  trash: { one: "Moved to trash", many: (count) => `${count} moved to trash` },
  snooze: { one: "Snoozed", many: (count) => `${count} snoozed` },
  block: { one: "Blocked", many: (count) => `${count} blocked` },
  // Matches `Screener.tsx`'s own "Returned" verdict label for Deny.
  deny: { one: "Returned", many: (count) => `${count} returned` },
  // Discard (#101) — `Composer.tsx`'s own explicit Discard button.
  discard: { one: "Draft discarded", many: (count) => `${count} drafts discarded` },
};

interface Bucket {
  count: number;
  undos: (() => void)[];
  timer: ReturnType<typeof setTimeout>;
}

const buckets = new Map<UndoableActionKind, Bucket>();
/** Which kinds currently hold a visible toast, oldest first — capped at `MAX_STACKED_TOASTS`. */
const stackedKinds: UndoableActionKind[] = [];

function toastId(kind: UndoableActionKind): string {
  return `undo-toast-${kind}`;
}

function clearBucket(kind: UndoableActionKind): void {
  const bucket = buckets.get(kind);
  if (bucket) clearTimeout(bucket.timer);
  buckets.delete(kind);
  const index = stackedKinds.indexOf(kind);
  if (index !== -1) stackedKinds.splice(index, 1);
}

function render(kind: UndoableActionKind): void {
  const bucket = buckets.get(kind);
  if (!bucket) return;
  const label = bucket.count === 1 ? LABELS[kind].one : LABELS[kind].many(bucket.count);
  raiseActionToast({
    id: toastId(kind),
    message: label,
    durationMs: WINDOW_MS,
    action: {
      label: "Undo",
      onClick: () => {
        for (const undo of bucket.undos) undo();
        clearBucket(kind);
      },
    },
  });
}

/**
 * Folds `undo` into `kind`'s current window, raising or updating its toast.
 * Called once per undoable action, right after the forward Optimistic
 * Action is enqueued — `undo` itself is just another `enqueueMutation` call
 * (the exact inverse intent), which is what makes it work "whether or not
 * the flush already happened" (ADR-0019).
 */
export function announceUndoableAction(kind: UndoableActionKind, undo: () => void): void {
  const existing = buckets.get(kind);
  if (existing) {
    existing.count += 1;
    existing.undos.push(undo);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => clearBucket(kind), WINDOW_MS);
    render(kind);
    return;
  }

  if (!stackedKinds.includes(kind) && stackedKinds.length >= MAX_STACKED_TOASTS) {
    const oldest = stackedKinds.shift();
    if (oldest) dismissActionToast(toastId(oldest));
  }
  stackedKinds.push(kind);
  buckets.set(kind, {
    count: 1,
    undos: [undo],
    timer: setTimeout(() => clearBucket(kind), WINDOW_MS),
  });
  render(kind);
}

/** Test seam: the module-level buckets outlive any one test's toasts, same shape `sync-loop.ts#resetSyncStatus` gives its own module state. */
export function resetUndoToastsForTest(): void {
  for (const kind of [...buckets.keys()]) clearBucket(kind);
}
