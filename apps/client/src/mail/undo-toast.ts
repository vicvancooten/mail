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

/**
 * `"noteDelete"` (#194) is Notes' own undoable action — `notes/NotesGrid.tsx`
 * and `notes/NoteDialog.tsx` call `announceUndoableAction` right after
 * `store/notes.ts#trashNote` the same way `useTriage.ts`'s `trash` does,
 * despite this module living under `mail/`: it was already the one place
 * "render it through the same toast component" (#95's own words) means, and
 * a Note's delete is exactly as undoable as a Thread's.
 *
 * `"addToNotes"` (#195) is the inverse case — `mail/MailSection.tsx`'s
 * `onAddToNotes` handler undoes itself by deleting the Note it just created.
 *
 * `"contactDelete"` (#224) is `"noteDelete"`'s own Contact-side counterpart
 * — `contacts/ContactDialog.tsx`'s Delete control calls `announceUndoableAction`
 * right after `store/contacts.ts#trashContact`. On a linked card the Sync
 * Backend cascades that one intent to every linked record (ADR-0026), so a
 * single announce and a single `restoreContact(id)` are the whole of what
 * "one Undo restores all" needs on the Client's own side.
 *
 * `"taskComplete"` (#252) is Tasks' own undoable action — `tasks/TaskListView.tsx`
 * calls `announceUndoableAction` right after `store/tasks.ts#completeTask`
 * the same way `noteDelete` rides `trashNote`, despite this module living
 * under `mail/`: ticking several rows in quick succession folds into the
 * same "N completed · Undo" toast, `#95`'s own bucketing already built for
 * exactly this shape.
 *
 * `"taskDelete"`/`"taskListDelete"` (#253/#257) are Tasks' own soft-delete
 * pair, `"noteDelete"`'s exact shape — `tasks/TaskEditor.tsx`'s own Delete
 * control and `tasks/TasksSidebar.tsx`'s each call `announceUndoableAction`
 * right after `store/tasks.ts#trashTask`/`deleteTaskList` respectively. Two
 * separate kinds, not one shared bucket: a Task delete folded together with
 * a List delete would let one Undo reverse both, which is never what either
 * control alone means to undo.
 *
 * `"taskSectionDelete"` (#255) is that same shape one level down — a
 * Section's own delete/restore pair, `tasks/TaskListView.tsx`'s group
 * heading control calling `announceUndoableAction` right after
 * `store/tasks.ts#deleteSection`. Its own bucket, not folded into
 * `"taskDelete"`: deleting a Section moves Tasks rather than deleting them,
 * and Undo here means `restoreSection`, not `restoreTask`.
 *
 * `"taskReschedule"` (#261) is a dragged Task chip's own kind —
 * `calendar/calendar-task-drag.ts#rescheduleTaskTo`, right after the
 * Calendar's `setTaskDueDate` field-patch — its own bucket, not folded into
 * `"taskComplete"`: dragging several chips in quick succession undoes only
 * the reschedules, never an unrelated tick sitting in the same window.
 *
 * `"eventReschedule"` (#305) is a dragged Event chip's own kind —
 * `calendar/calendar-event-drag.ts#commitEventMove`, right after the drop's
 * chosen scope writes the new start/end — its own bucket, not folded into
 * `"eventMove"`: dragging several chips undoes only the reschedules, never
 * an unrelated Calendar Move sitting in the same window.
 *
 * `"addToTask"`/`"addToTaskAndDone"` (#258) are "Add to Tasks"'s own pair —
 * `mail/MailSection.tsx`'s `onAddToTasksConfirm`/`onAddToTasksConfirmAndDone`
 * handlers, `"addToNotes"`'s exact shape for the first, except the second is
 * a genuinely **compound** intent: creating the Task *and* archiving the
 * Thread under one toast whose one Undo reverses both together (deletes the
 * Task, restores the Thread to the Inbox) — never folded into the ordinary
 * `"done"` bucket `useTriage.ts#archive` already announces its own Undo
 * into, which would let an unrelated `e` press's Undo also delete this Task
 * (or vice versa).
 */
export type UndoableActionKind =
  | "done"
  | "trash"
  | "snooze"
  | "block"
  | "spam"
  | "approve"
  | "deny"
  | "discard"
  | "noteDelete"
  | "addToNotes"
  | "contactDelete"
  | "contactImport"
  | "contactCopy"
  | "contactMove"
  | "taskComplete"
  | "taskDelete"
  | "taskListDelete"
  | "taskSectionDelete"
  | "taskReschedule"
  | "addToTask"
  | "addToTaskAndDone"
  | "eventDelete"
  | "seriesDelete"
  | "eventMove"
  | "eventReschedule"
  | "invitationAnswer";

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
  // Note delete (#194) — `notes/NotesGrid.tsx`'s card control and
  // `notes/NoteDialog.tsx`'s own Delete button.
  noteDelete: { one: "Note deleted", many: (count) => `${count} Notes deleted` },
  // "Add to Notes" (#195) — `mail/MailSection.tsx`'s own `onAddToNotes` handler.
  addToNotes: { one: "Added to Notes", many: (count) => `${count} added to Notes` },
  // Contact delete (#224) — `contacts/ContactDialog.tsx`'s own Delete control.
  contactDelete: { one: "Contact deleted", many: (count) => `${count} Contacts deleted` },
  // vCard import/Copy/Move (#225) — a tight import loop's own per-card calls
  // coalesce into one toast the same way a fast keyboard Triage burst does,
  // which is exactly the "one toast with the count" the import sheet's own
  // acceptance line asks for, with no extra batching logic of its own.
  contactImport: { one: "1 Contact imported", many: (count) => `${count} Contacts imported` },
  contactCopy: { one: "Contact copied", many: (count) => `${count} Contacts copied` },
  contactMove: { one: "Contact moved", many: (count) => `${count} Contacts moved` },
  // Task complete (#252) — `tasks/TaskListView.tsx`'s own checkbox row.
  taskComplete: { one: "Completed", many: (count) => `${count} completed` },
  // Task delete (#253) — `tasks/TaskEditor.tsx`'s own Delete control.
  taskDelete: { one: "Task deleted", many: (count) => `${count} Tasks deleted` },
  // Task List delete (#257) — `tasks/TasksSidebar.tsx`'s own row control.
  taskListDelete: { one: "Task List deleted", many: (count) => `${count} Task Lists deleted` },
  // Section delete (#255) — `tasks/TaskListView.tsx`'s own group heading control.
  taskSectionDelete: { one: "Section deleted", many: (count) => `${count} Sections deleted` },
  // Dragging a Task chip to another day on the Calendar (#261) — `calendar/calendar-task-drag.ts#rescheduleTaskTo`.
  taskReschedule: { one: "Task rescheduled", many: (count) => `${count} Tasks rescheduled` },
  // "Add to Tasks" (#258) — `mail/MailSection.tsx`'s own `onAddToTasksConfirm` handler.
  addToTask: { one: "Added to Tasks", many: (count) => `${count} added to Tasks` },
  // "Add to Tasks" + mark Done (#258) — the compound handler, one toast for both.
  addToTaskAndDone: {
    one: "Added to Tasks and marked Done",
    many: (count) => `${count} added to Tasks and marked Done`,
  },
  // Deleting one Occurrence (#233) — `calendar/EventEditorPopover.tsx`'s own
  // `addExdate` call, undone by its real inverse `removeExdate`.
  eventDelete: { one: "Event deleted", many: (count) => `${count} events deleted` },
  // Deleting a whole Series (#233) — `trashSeries`, undone by `restoreSeries`
  // within its 24-hour snapshot window.
  seriesDelete: { one: "Event deleted", many: (count) => `${count} events deleted` },
  // Moving an Event between Calendars (#238) — `EventEditorPopover.tsx`'s own
  // Move picker, undone by `restoreSeries`/`trashSeries` on the two Series
  // ids the Move touched.
  eventMove: { one: "Event moved", many: (count) => `${count} events moved` },
  // Dragging an Event chip to a new time or day on the grid (#305) —
  // `calendar/calendar-event-drag.ts#commitEventMove`, undone by writing the
  // exact previous start/end (or, for "this and following", the previous
  // `rrules` plus deleting the continuation Series it split off).
  eventReschedule: { one: "Event rescheduled", many: (count) => `${count} events rescheduled` },
  // Answering an Invitation on a synced Calendar (#240, ADR-0027) — the
  // Reader's invite card's own Accept/Maybe/Decline buttons, undone by
  // answering again with the previous `responseStatus`. Never raised for a
  // first Answer (`previousResponseStatus === "needsAction"`): neither
  // Google nor Graph's `REPLY` shape can express that value back.
  invitationAnswer: { one: "Answered", many: (count) => `${count} invitations answered` },
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
  // Every caller (Undo clicked, the bucket's own window timer, the test
  // reset below) retires this kind's bookkeeping — the toast itself has to
  // go with it, or a kind that outlives its window (sonner's own `duration`
  // hasn't fired yet — the common case in a test with no real clock) stays
  // mounted for a later `render()` call with the same id to collide with.
  dismissActionToast(toastId(kind));
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
