import { BULK_TRIAGE_UNDO_WINDOW_SECONDS } from "@mail/shared";
import { dismissActionToast, raiseActionToast } from "./action-toast.js";

/**
 * Coalesced Undo toasts for the ordinary Triage/Screener/Compose actions
 * (#95, ADR-0019, CONTEXT.md's own Undo entry: "actions taken in quick
 * succession share one toast and one Undo"). `useTriage.ts`'s `archive`/
 * `trash`/`snooze`/`spamSender`/`blockSender`/`approveSender`,
 * `screener/Screener.tsx`'s Deny/Block/Spam decisions, and
 * `compose/Composer.tsx`'s explicit Discard (#101) each call
 * `announceUndoableAction` right after enqueueing the forward Optimistic
 * Action — Star/Pin/Read/Label never do, matching #95's own list of what's
 * undoable, and neither does a Draft that discards silently on close with no
 * content (`Composer.tsx`'s own doc comment). The Screener's own Approve is
 * the one exception left standing: releasing a stranger's mail there needs
 * no second thoughts the way trashing it does (CONTEXT.md's Undo entry
 * doesn't list it) — but `useTriage.ts`'s own Approve, reached from an Inbox
 * Thread the User is already looking at (#144), is exactly the kind of
 * second thought Undo exists for, so it announces too.
 *
 * `spam`, `block` and `approve` are three of their own kinds, not folded
 * together (#108, resolved here): a coalesced toast has to say which of the
 * three actually happened, the whole point of #144's "each announces itself
 * by name". Before this, `screener/Screener.tsx`'s own Spam decision
 * deliberately reused the `"block"` bucket rather than add a fourth kind —
 * see this module's git history for that reasoning — which is exactly the
 * coalescing bug #108 named; splitting it out here fixes the Screener's own
 * toast too, not only the new Inbox Thread surfaces.
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

export type UndoableActionKind =
  | "done"
  | "trash"
  | "snooze"
  | "block"
  | "spam"
  | "approve"
  | "deny"
  | "discard";

const WINDOW_MS = BULK_TRIAGE_UNDO_WINDOW_SECONDS * 1000;
const MAX_STACKED_TOASTS = 2;

const LABELS: Record<UndoableActionKind, { one: string; many: (count: number) => string }> = {
  done: { one: "Done", many: (count) => `${count} done` },
  trash: { one: "Moved to trash", many: (count) => `${count} moved to trash` },
  snooze: { one: "Snoozed", many: (count) => `${count} snoozed` },
  block: { one: "Blocked", many: (count) => `${count} blocked` },
  // Spam (#102, #144) — its own kind since #108: coalescing it under
  // `"block"` is exactly the bug that ticket named.
  spam: { one: "Spam", many: (count) => `${count} marked as Spam` },
  // Approve (#144) — only `useTriage.ts`'s Inbox Thread Approve ever
  // announces this; the Screener's own Approve stays silent (this module's
  // own doc comment).
  approve: { one: "Approved", many: (count) => `${count} approved` },
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
    // `existing` can be a bucket that's still counting but was evicted from
    // `stackedKinds` (no visible toast) by a third kind arriving earlier —
    // re-arming it here has to re-enter it into `stackedKinds`, evicting the
    // oldest in turn if the stack is already full, or `render` below puts a
    // toast on screen for a kind `stackedKinds` doesn't know about, letting
    // the visible stack exceed `MAX_STACKED_TOASTS`.
    if (!stackedKinds.includes(kind)) {
      if (stackedKinds.length >= MAX_STACKED_TOASTS) {
        const oldest = stackedKinds.shift();
        if (oldest) dismissActionToast(toastId(oldest));
      }
      stackedKinds.push(kind);
    }
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
