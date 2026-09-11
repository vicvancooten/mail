import type { Label, Task, TaskList } from "@mail/shared";
import type { TaskSwimlane } from "../mail/device-preferences.js";
import { labelNameForId } from "../store/session.js";
import { DUE_BUCKETS, dueBucket } from "./task-due.js";

/** The fixed, always-last column (#256's own "a fixed Done column last") — never a real Section, so it renders no rename/delete/drag-reorder of its own and never sorts by manual `order`. */
export const BOARD_DONE_COLUMN_ID = "__done__";

/** The virtual bucket for a Task naming no Section, or one that's gone (`TaskListView.tsx#groupBySection`'s own "no longer exists" fallback) — a Board still needs somewhere to put it, unlike List mode's `sectioned` threshold, which can simply fold it into the one flat group. */
export const BOARD_UNSECTIONED_COLUMN_ID = "__unsectioned__";

export interface BoardColumn {
  id: string;
  name: string;
  /** `null` for the Done and "No section" columns — neither is a real Section. */
  sectionId: string | null;
  isDone: boolean;
}

/**
 * A Board's columns (#256): the List's own Sections, in their order, then —
 * only if some live Task actually needs it — a trailing "No section" column,
 * then the fixed Done column last. Unlike `TaskListView.tsx#groupBySection`
 * (gated behind `sectioned`, so a List can look plain below two Sections),
 * a Board always shows the structure it has: a zero-Section List still gets
 * a "No section" column to hold every one of its Tasks, since a Board with
 * nothing but "Done" would have nowhere for an active Task to appear at all.
 */
export function buildBoardColumns(taskList: TaskList, tasks: readonly Task[]): BoardColumn[] {
  const knownSectionIds = new Set(taskList.sections.map((section) => section.id));
  const needsUnsectionedColumn =
    taskList.sections.length === 0 ||
    tasks.some(
      (task) =>
        !task.completed && (task.sectionId === null || !knownSectionIds.has(task.sectionId)),
    );

  const columns: BoardColumn[] = taskList.sections.map((section) => ({
    id: section.id,
    name: section.name,
    sectionId: section.id,
    isDone: false,
  }));
  if (needsUnsectionedColumn) {
    columns.push({
      id: BOARD_UNSECTIONED_COLUMN_ID,
      name: "No section",
      sectionId: null,
      isDone: false,
    });
  }
  columns.push({ id: BOARD_DONE_COLUMN_ID, name: "Done", sectionId: null, isDone: true });
  return columns;
}

/** The live+completed Tasks (already swimlane-filtered by the caller) that belong in one column: Done pools every completed Task newest-`completedAt`-first (`TaskListView.tsx`'s own completed sort, `readTasks`'s doc comment on why completed Tasks are never windowed out); every other column pools its own Section's still-active Tasks in manual `order` — the "No section" column catching anything naming no Section, or one this List no longer has. */
export function tasksForColumn(
  rowTasks: readonly Task[],
  column: BoardColumn,
  knownSectionIds: ReadonlySet<string>,
): Task[] {
  if (column.isDone) {
    return rowTasks
      .filter((task) => task.completed)
      .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? ""));
  }
  const active = rowTasks.filter((task) => !task.completed);
  const matched =
    column.sectionId !== null
      ? active.filter((task) => task.sectionId === column.sectionId)
      : active.filter(
          (task) => task.sectionId === null || !knownSectionIds.has(task.sectionId as string),
        );
  return matched.slice().sort((left, right) => left.order - right.order);
}

export interface SwimlaneRow {
  key: string;
  /** `null` for "none" — the single, unheaded row a plain Board renders. */
  heading: string | null;
  tasks: Task[];
}

const NO_LABEL_HEADING = "No label";

/**
 * Cuts a Board into rows (#256's own three shapes): **none** (everything in
 * one unheaded row — a plain Board), **by Label**, or **by due bucket**
 * (`task-due.ts#dueBucket`'s own five, in that fixed urgency order). Purely a
 * display filter over the given (already Section-column-agnostic) Tasks — a
 * card's row never changes what dragging it between columns does
 * (`TaskBoardView.tsx`'s own doc comment on why drag only ever touches
 * Section/order/completion). Empty rows are dropped: a rarely-used Label or
 * an empty due bucket earns no bare heading with nothing under it.
 *
 * A Task with several Labels sits in exactly one row — its labels' names,
 * alphabetically first — rather than once per Label it carries: duplicating
 * a card across rows would make "drag it to Done" ambiguous about which copy
 * moved, and this Board has no independent notion of a card append two
 * places, unlike a real committee-style Kanban tool. A deliberate, documented
 * simplification (#256's own "decide routine calls yourself").
 */
export function buildSwimlaneRows(
  swimlane: TaskSwimlane,
  tasks: readonly Task[],
  labels: readonly Label[],
  now: Date = new Date(),
): SwimlaneRow[] {
  if (swimlane === "none") return [{ key: "all", heading: null, tasks: tasks.slice() }];

  if (swimlane === "dueBucket") {
    const byBucket = new Map<string, Task[]>();
    for (const task of tasks) {
      const bucket = dueBucket(task.dueDate, now);
      const bucketTasks = byBucket.get(bucket);
      if (bucketTasks) bucketTasks.push(task);
      else byBucket.set(bucket, [task]);
    }
    return DUE_BUCKETS.filter((bucket) => (byBucket.get(bucket.id)?.length ?? 0) > 0).map(
      (bucket) => ({
        key: bucket.id,
        heading: bucket.label,
        tasks: byBucket.get(bucket.id) as Task[],
      }),
    );
  }

  // swimlane === "label"
  const nameById = new Map(labels.map((label) => [label.id, label.name]));
  const byHeading = new Map<string, Task[]>();
  for (const task of tasks) {
    const names = task.labelIds
      .map((id) => nameById.get(id) ?? labelNameForId(id))
      .sort((left, right) => left.localeCompare(right));
    const heading = names[0] ?? NO_LABEL_HEADING;
    const headingTasks = byHeading.get(heading);
    if (headingTasks) headingTasks.push(task);
    else byHeading.set(heading, [task]);
  }
  const headings = [...byHeading.keys()]
    .filter((heading) => heading !== NO_LABEL_HEADING)
    .sort((left, right) => left.localeCompare(right));
  if (byHeading.has(NO_LABEL_HEADING)) headings.push(NO_LABEL_HEADING);
  return headings.map((heading) => ({
    key: heading,
    heading,
    tasks: byHeading.get(heading) as Task[],
  }));
}
