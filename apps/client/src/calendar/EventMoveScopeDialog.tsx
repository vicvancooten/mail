import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { commitEventMove, type EventDragScope } from "./calendar-event-drag.js";
import { closeEventMoveScopePrompt, usePendingEventMove } from "./calendar-event-move-panel.js";

/**
 * "Asks whether to change this event, this and following, or all, before
 * anything is written" (#305's own acceptance line) — one instance mounted
 * in `CalendarRoute.tsx`, the same "one shared state, one mounted dialog"
 * shape `EventEditorPopover.tsx` already has for its own Send/Don't send
 * prompt. Dismissing (Cancel, the overlay, Escape) writes nothing at all —
 * `closeEventMoveScopePrompt` only ever clears the pending drop, never
 * commits a default scope on the User's behalf.
 */
export function EventMoveScopeDialog() {
  const pending = usePendingEventMove();

  function choose(scope: EventDragScope) {
    if (!pending) return;
    void commitEventMove(pending, scope);
    closeEventMoveScopePrompt();
  }

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) closeEventMoveScopePrompt();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move recurring event</DialogTitle>
          <DialogDescription>
            This event repeats. Which events do you want to move?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => choose("this")}>
            This event
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => choose("thisAndFollowing")}
          >
            This and following
          </Button>
          <Button type="button" size="sm" onClick={() => choose("all")}>
            All events
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
