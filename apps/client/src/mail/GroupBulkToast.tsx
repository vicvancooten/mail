import { raiseActionToast } from "./action-toast.js";

/**
 * The group header cluster's own toast (#66, #77) — `RollbackToast`'s
 * sibling for the group-bulk path rather than a single Optimistic Action:
 * names the true affected count, offers Undo when the action is undoable,
 * and persists longer than an ordinary toast (~10s, `BULK_TRIAGE_UNDO_WINDOW_SECONDS`)
 * so the most expensive misclick in the product stays recoverable. A
 * partial-failure or rollback message reuses the same surface with no Undo
 * button and a shorter life.
 *
 * Raised through the same `action-toast.ts` call every ordinary Triage Undo
 * toast uses (#95, `undo-toast.ts`) — "render it through the same toast
 * component" (#95's own issue text). A fixed `id` means `MailSection`'s two
 * call sites (the group-bulk response, and its own rollback path) replace
 * one another in place rather than stacking — unlike a real Optimistic
 * Action this path never goes through the mutation queue (#67: "outside the
 * Optimistic Action queue... a group can hold thousands the Client never
 * loaded"), so there is no `subscribeMutationRejections` feed to raise this
 * from; `MailSection` calls this function directly instead.
 */

const TOAST_ID = "mail-group-bulk-toast";

export interface GroupBulkToastState {
  message: string;
  /** Present only for an undoable Done all, and only while its Undo window is still open. */
  onUndo?: () => void;
  durationMs: number;
}

export function showGroupBulkToast(state: GroupBulkToastState): void {
  raiseActionToast({
    id: TOAST_ID,
    message: state.message,
    durationMs: state.durationMs,
    action: state.onUndo ? { label: "Undo", onClick: state.onUndo } : undefined,
  });
}
