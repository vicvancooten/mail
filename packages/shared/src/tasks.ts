import { z } from "zod";
import { noteDocumentSchema } from "./notes.js";

/**
 * `Task` and `TaskList` (#251, epic #249, ADR-0030): the two collections
 * Tasks rides, on the wire, "the same shape #192 took for Notes" — both
 * registry descriptors (`sync/collection-registry.ts` on both sides), both
 * User-scoped, both replicating **whole** (no windowing, completed Tasks
 * included), both a document-backed collection whose body rides
 * `documentSaves` (`sync.ts#documentSaveSchema`) rather than the structural
 * queue below.
 *
 * A Task's body reuses `noteDocumentSchema` verbatim (ADR-0024: "the editor
 * and document model the body reuses") rather than a parallel schema this
 * file would have to keep in lock-step — one BlockNote document model, two
 * collections riding it.
 */

/** One entry of a Task List's ordered Sections (#251) — a plain array field on the `TaskList` row, not a collection of its own ("five entries per List do not earn a third registry descriptor and a delta stream"). A Task names one by id (`taskSchema#sectionId`), or none at all. */
export const taskSectionSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type TaskSection = z.infer<typeof taskSectionSchema>;

/**
 * `TaskList` (#251): **User-scoped**, whole-replicated, ids **client-generated
 * ULIDs** the same way a Note's is — except the User's very first List, which
 * `sync/task-list-store.ts#ensureDefaultTaskList` seeds **server-side** on
 * that User's first sync of the collection, named "Tasks", so two devices
 * opening the App at once cannot mint two of them.
 *
 * `isDefault` is that seeded row's own flag, stamped once at creation and
 * never recomputed — "a property of being the User's first List, not a name
 * check": renaming it away from "Tasks" leaves `isDefault` (and the
 * `deleteTaskList` rejection it drives, `sync/mutations.ts`) untouched.
 *
 * `order` is this User's own ordering of their Lists (`reorderTaskList`) —
 * an absolute-set field, the same shape `sync.ts`'s `setStarred`-style
 * intents already use, with no natural inverse of its own: the Client
 * captures the old value to build Undo's real inverse (ADR-0019), the same
 * way `renameTaskList`/`setTaskTitle` do.
 *
 * `deletedAt` (`deleteTaskList`/`restoreTaskList`, ADR-0019): a genuine
 * inverse pair, `notes.ts#noteSchema`'s own `trashNote`/`restoreNote` shape
 * — the row keeps syncing as an ordinary `updated` row while it's set, never
 * a tombstone until the Sync Backend's registry-driven purge sweep
 * (`TASK_TRASH_RETENTION_DAYS` below, #257) removes it for good.
 * `deleteTaskList` is rejected outright (`default_list`) for the seeded
 * default List — see its own doc comment in `sync/mutations.ts`.
 */
export const taskListSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  sections: z.array(taskSectionSchema),
  isDefault: z.boolean(),
  order: z.number(),
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TaskList = z.infer<typeof taskListSchema>;

/** The name `sync/task-list-store.ts#ensureDefaultTaskList` seeds a brand-new User's first List with — the ticket's own "named 'Tasks'". */
export const DEFAULT_TASK_LIST_NAME = "Tasks";

/**
 * How long a soft-deleted Task or Task List stays in Recently Deleted before
 * `sync/trash-purge.ts` purges it for good (#257's own acceptance line: "30
 * days after deletion") — `notes.ts#NOTE_TRASH_RETENTION_DAYS`'s own window,
 * shared here rather than duplicated since both Task and TaskList (a Task
 * cascaded into Recently Deleted by its own List's delete carries the same
 * `deletedAt` stamp the List itself does) purge on the same schedule.
 */
export const TASK_TRASH_RETENTION_DAYS = 30;

/**
 * The seeded default List's own id: deterministic from the User alone (the
 * same reasoning `labels.ts#labelId` gives a Label's), rather than a fresh
 * ULID minted per attempt — which is what makes seeding it idempotent under
 * two devices racing their first sync of the collection with a plain
 * `onConflictDoNothing` (`sync/task-list-store.ts`), no extra unique index
 * or locking required.
 */
export function defaultTaskListId(userId: string): string {
  return `${userId}:default`;
}

/**
 * `Task` (#251): **User-scoped**, whole-replicated, completed Tasks
 * included and never windowed out — "what later makes the Reader's Task
 * chips and the Calendar overlay a local lookup rather than a request." Id
 * is a client-generated ULID, present from the moment of creation
 * (`createTask`), the same "address exists before the round trip" shape a
 * Note's own id already has.
 *
 * `taskListId`/`sectionId` place a Task: `sectionId` is nullable — a Task
 * with no Section sits unsectioned in its List, the default a brand-new
 * List (zero Sections) leaves every Task in until the User adds one. Moved
 * by `setTaskSection` (same List) or `setTaskList` (a different List,
 * carrying its own destination `sectionId` since Sections don't cross Lists)
 * — both absolute sets, self-inverse via the Client's captured old value,
 * `taskListSchema#order`'s own shape.
 *
 * `title`/`dueDate` are this ticket's own "patch its fields per field" —
 * each its own absolute-set intent (`setTaskTitle`/`setTaskDueDate`) rather
 * than one generic patch, the same one-intent-per-field posture
 * `sync.ts#userMutationIntentSchema`'s Preference variants already take.
 * Further fields (a later ticket's own) land additively, never a reshape
 * (ADR-0023).
 *
 * `completed`/`completedAt` is `completeTask`/`uncompleteTask`'s own genuine
 * inverse pair, `pinNote`/`unpinNote`'s shape. `order` is this Task's
 * position within its List/Section (`reorderTask`), absolute-set like
 * `taskListSchema#order`. `document` is the BlockNote body — the row's own
 * copy, kept current by the `documentSaves` channel
 * (`sync.ts#documentSaveSchema`) the same way `notes.ts#noteSchema#document`
 * already is, so a bootstrap or a second device's catch-up never needs a
 * separate request for it.
 *
 * `dueDate`/`dueTime` (#253): a Task's Due is a **zone-less calendar day**
 * plus an optional **floating wall-clock time**, never a real zoned instant
 * — the same distinction an all-day Calendar Event's date draws against a
 * timed one's. `dueDate` carries only its Y-M-D (always encoded at UTC
 * midnight, `tasks/task-due.ts#dateOnlyToWireDueDate`; every reader extracts
 * the day with a UTC getter/formatter, never a local one, so the same string
 * reads as the same day in every zone) — deliberately **not** reused to also
 * carry the time, since "the same instant, but midnight" is indistinguishable
 * from "no time was ever set"; `dueTime` is its own nullable `"HH:MM"` field
 * for exactly that reason, rendered by formatting against a fixed UTC offset
 * (`task-due.ts#formatDueTime`) rather than the reader's own zone, which is
 * what "floating" means. `dueTime` is never set without `dueDate` (the Due
 * picker's own invariant, `TaskDuePicker.tsx`) — a Client clearing `dueDate`
 * always clears `dueTime` in the same breath.
 *
 * `labelIds` (#253): membership in this User's one Label set (#186), the
 * same shape `notes.ts#noteSchema#labelIds` already gives a Note — Tasks
 * reuses mail's own `LabelPicker` over it unchanged.
 *
 * `deletedAt` (`trashTask`/`restoreTask`) is the soft pair, `noteSchema`'s
 * own shape, purged `TASK_TRASH_RETENTION_DAYS` on by `sync/trash-purge.ts`
 * (#257); `createTask`/`deleteTask` is the separate **hard** pair — "the
 * permanent delete that undoes a still-queued or already-applied
 * `createTask`" (`notes.ts#noteSchema`'s own `deleteNote` doc comment,
 * word for word the same reasoning here).
 */
/**
 * A Task's own Thread Link **field** (#258, epic #249) — set once at
 * creation (`createTask`'s own mutation payload below) and never patched
 * afterward, unlike `title`/`dueDate`. This is the snapshot that drives the
 * row's and the expanded editor's mail chip: a Thread's id plus its
 * subject, participants and date, so the chip still reads once the Thread
 * itself is deleted — mirrors `apps/client/src/store/notes.ts`'s own
 * `ThreadLinkSnapshot` exactly, the two kept structurally identical rather
 * than one importing the other across the client/shared boundary.
 *
 * Distinct from the optional Thread Link **block** a User may also insert
 * into a Task's body (`notes.ts`'s own custom BlockNote block, #195,
 * unchanged) — "only the field drives chips" (the ticket's own words): a
 * Task can hold zero, one or several Thread Link blocks in its body with no
 * effect on this field, and this field exists independently of whether the
 * body carries a block at all.
 */
export const taskThreadLinkSchema = z.object({
  threadId: z.string(),
  subject: z.string(),
  participants: z.string(),
  date: z.string(),
});
export type TaskThreadLink = z.infer<typeof taskThreadLinkSchema>;

export const taskSchema = z.object({
  id: z.string(),
  userId: z.string(),
  taskListId: z.string(),
  sectionId: z.string().nullable(),
  title: z.string(),
  document: noteDocumentSchema,
  completed: z.boolean(),
  completedAt: z.iso.datetime().nullable(),
  dueDate: z.iso.datetime().nullable(),
  dueTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  labelIds: z.array(z.string()),
  threadLink: taskThreadLinkSchema.nullable(),
  order: z.number(),
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Task = z.infer<typeof taskSchema>;
