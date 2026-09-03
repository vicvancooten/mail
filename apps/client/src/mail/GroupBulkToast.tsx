import { useEffect } from "react";

/**
 * The group header cluster's own toast (#66, #77) — `RollbackToast`'s
 * sibling for the group-bulk path rather than a single Optimistic Action:
 * names the true affected count, offers Undo when the action is undoable,
 * and persists longer than an ordinary toast (~10s, `BULK_TRIAGE_UNDO_WINDOW_SECONDS`)
 * so the most expensive misclick in the product stays recoverable. A
 * partial-failure or rollback message reuses the same surface with no Undo
 * button and a shorter life.
 *
 * Mounted once in `MailSection`, state owned there — unlike `RollbackToast`
 * this path never goes through the Optimistic Action queue (#67: "outside
 * the Optimistic Action queue... a group can hold thousands the Client
 * never loaded"), so there is no `subscribeMutationRejections` feed to
 * listen on here.
 */

export interface GroupBulkToastState {
  message: string;
  /** Present only for an undoable Done all, and only while its Undo window is still open. */
  onUndo?: () => void;
  durationMs: number;
}

export function GroupBulkToast({
  state,
  onDismiss,
}: {
  state: GroupBulkToastState | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!state) return;
    const timer = setTimeout(onDismiss, state.durationMs);
    return () => clearTimeout(timer);
  }, [state, onDismiss]);

  if (!state) return null;

  return (
    <div className="group-bulk-toast" role="status">
      <span>{state.message}</span>
      {state.onUndo ? (
        <button
          type="button"
          className="group-bulk-toast-undo"
          onClick={() => {
            state.onUndo?.();
            onDismiss();
          }}
        >
          Undo
        </button>
      ) : null}
    </div>
  );
}
