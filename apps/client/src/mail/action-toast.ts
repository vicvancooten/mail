import { toast } from "sonner";

/**
 * The one call every Triage toast with a button goes through (#95):
 * `undo-toast.ts`'s per-kind coalescing raiser, `GroupBulkToast.tsx`'s
 * server-batch raiser, and `RollbackToast.tsx`'s Retry all render through
 * this — "render it through the same toast component" (#95's own issue
 * text) means the same Sonner call shape, not three hand-rolled ones that
 * happen to look alike.
 */
export interface ActionToastOptions {
  /** A fixed id per surface (a Triage action kind, the group-bulk cluster, the rollback slot) — a later call with the same id replaces it in place rather than stacking. */
  id: string;
  message: string;
  durationMs: number;
  /** Omitted for a plain message (a partial failure past its own Undo window) with nothing left to act on. */
  action?: { label: string; onClick: () => void };
}

export function raiseActionToast({ id, message, durationMs, action }: ActionToastOptions): void {
  toast(message, { id, duration: durationMs, action });
}

/** Closes one action toast early, without touching whatever it was still tracking (`undo-toast.ts`'s own eviction, say). */
export function dismissActionToast(id: string): void {
  toast.dismiss(id);
}
