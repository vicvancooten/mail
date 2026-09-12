import { Calendar, Tag, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import { LabelPicker } from "../mail/LabelPicker.js";
import { announceUndoableAction } from "../mail/undo-toast.js";
import { NoteEditor } from "../notes/NoteEditor.js";
import {
  labelTask,
  restoreTask,
  setTaskDueDate,
  setTaskDueTime,
  setTaskList,
  setTaskSection,
  setTaskTitle,
  trashTask,
  unlabelTask,
  useLabels,
  useRegionFormatSettings,
  useTask,
  useTaskList,
  useTaskLists,
} from "../store/index.js";
import { TaskDuePicker } from "./TaskDuePicker.js";
import { TaskThreadLinkChip } from "./TaskThreadLinkChip.js";
import { formatDueDate, formatDueTime } from "./task-due.js";
import { useFocusOnMount } from "./use-focus-on-mount.js";
import { useTaskAutosave } from "./use-task-autosave.js";

/**
 * A Task's expanded row (#253): "the full Task, edited where it sits" — the
 * title, the BlockNote body (reusing #191's editor and block schema
 * unchanged, the same way `notes/NoteDialog.tsx` embeds it), its Task List,
 * Section, Due and Labels, plus Delete. Mounted by `TaskRow.tsx` in place of
 * the collapsed summary, never a second surface — there is no Save button
 * and no "done editing" step anywhere here: every field commits the instant
 * it changes, `NoteDialog.tsx`'s own posture.
 *
 * Takes only `taskId` and reads the row itself via `useTask` — `NoteDialog.tsx`'s
 * own "the store is truth" posture (ADR-0010), not `TaskRow.tsx`'s already-live
 * `task` prop, so a field this editor just wrote never has to wait on a
 * parent re-render to reflect back here.
 */
export function TaskEditor({ taskId, onCollapse }: { taskId: string; onCollapse: () => void }) {
  const task = useTask(taskId);
  const [titleDraft, setTitleDraft] = useState(task?.title ?? "");
  const [dueOpen, setDueOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const titleRef = useFocusOnMount<HTMLInputElement>();
  const autosave = useTaskAutosave(taskId);
  const taskList = useTaskList(task?.taskListId ?? null);
  const taskLists = useTaskLists();
  const labels = useLabels();
  const region = useRegionFormatSettings();

  // Seeds `titleDraft` from the live row — needed because `task` itself
  // resolves asynchronously (`useTask`'s own live query), so the initial
  // `useState(task?.title ?? "")` above usually starts from `""` and only
  // catches up once this fires. Skipped while `titleDirtyRef` is set — the
  // User has typed something this editor hasn't committed yet, so a rename
  // arriving from elsewhere in that window (even this same edit, echoed back
  // through the live query moments after `commitTitle` calls `setTaskTitle`)
  // must not fight the keystrokes still in progress. `onChange` sets the
  // flag, `commitTitle` clears it — not focus, which would also block the
  // very first sync here: `useFocusOnMount` focuses this field before
  // `task` ever resolves.
  const titleDirtyRef = useRef(false);
  const liveTitle = task?.title;
  useEffect(() => {
    if (liveTitle !== undefined && !titleDirtyRef.current) setTitleDraft(liveTitle);
  }, [liveTitle]);

  if (!task) return null;

  // A fresh, definitely-`Task` binding — `task` itself stays `Task | undefined`
  // to the type checker inside a nested closure (TS does not carry the guard
  // above's narrowing across a function boundary), so every handler below
  // closes over this instead.
  const current = task;

  function commitTitle() {
    titleDirtyRef.current = false;
    const trimmed = titleDraft.trim();
    if (trimmed.length === 0) {
      setTitleDraft(current.title);
      return;
    }
    if (trimmed !== current.title) void setTaskTitle(current.id, trimmed);
  }

  function handleSetDueDate(dueDate: string | null) {
    void setTaskDueDate(current.id, dueDate);
    // A Task's `dueTime` must never outlive its `dueDate` (`@mail/shared`'s
    // `taskSchema` own doc comment) — clearing the date always clears the
    // time in the same breath.
    if (dueDate === null) void setTaskDueTime(current.id, null);
  }

  function handleSetDueTime(dueTime: string | null) {
    void setTaskDueTime(current.id, dueTime);
  }

  /**
   * Delete (#253's own "plus Delete"): fires the same Optimistic Action +
   * Undo toast `notes/NoteDialog.tsx#handleDelete` does, riding the existing
   * `trashTask`/`restoreTask` pair (#251) — the greyed Recently Deleted view
   * itself is #257's own slice, not this one's. Collapses the row first:
   * once the Task is gone, there is nothing left here to keep expanded.
   */
  function handleDelete() {
    onCollapse();
    void trashTask(current.id);
    announceUndoableAction("taskDelete", () => void restoreTask(current.id));
  }

  const applyLabelActions = {
    applyLabel: (id: string, name: string) => void labelTask(id, name),
    removeLabel: (id: string, name: string) => void unlabelTask(id, name),
  };

  return (
    <div className="task-editor">
      <input
        type="text"
        className="task-editor-title"
        value={titleDraft}
        ref={titleRef}
        aria-label="Task title"
        onChange={(event) => {
          titleDirtyRef.current = true;
          setTitleDraft(event.target.value);
        }}
        onBlur={commitTitle}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            (event.target as HTMLInputElement).blur();
          }
          if (event.key === "Escape") {
            titleDirtyRef.current = false;
            setTitleDraft(current.title);
          }
        }}
      />
      <NoteEditor
        document={current.document}
        onChange={autosave.onChange}
        className="task-editor-body"
      />
      <div className="task-editor-fields">
        <label className="task-editor-field">
          <span>List</span>
          <select
            value={current.taskListId}
            onChange={(event) => void setTaskList(current.id, event.target.value, null)}
          >
            {(taskLists ?? []).map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </select>
        </label>
        <label className="task-editor-field">
          <span>Section</span>
          <select
            value={current.sectionId ?? ""}
            onChange={(event) =>
              void setTaskSection(current.id, event.target.value === "" ? null : event.target.value)
            }
          >
            <option value="">No section</option>
            {(taskList?.sections ?? []).map((section) => (
              <option key={section.id} value={section.id}>
                {section.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="task-editor-actions">
        {current.threadLink ? <TaskThreadLinkChip threadLink={current.threadLink} /> : null}
        <Popover open={dueOpen} onOpenChange={setDueOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={`task-editor-due-btn${dueOpen ? " on" : ""}`}
              aria-label="Due"
            >
              <Calendar size={14} />
              {current.dueDate ? (
                <span>
                  {formatDueDate(current.dueDate, region)}
                  {current.dueTime ? ` ${formatDueTime(current.dueTime, region)}` : ""}
                </span>
              ) : (
                <span>Due</span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto min-w-[220px] p-1.5">
            <TaskDuePicker
              dueDate={current.dueDate}
              dueTime={current.dueTime}
              onSetDate={handleSetDueDate}
              onSetTime={handleSetDueTime}
            />
          </PopoverContent>
        </Popover>
        <Popover open={labelsOpen} onOpenChange={setLabelsOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={`task-editor-labels-btn${labelsOpen ? " on" : ""}`}
              aria-label="Apply or remove a label"
            >
              <Tag size={14} />
              Labels
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto min-w-[220px] p-1.5">
            <LabelPicker
              thread={current}
              labels={labels ?? []}
              triage={applyLabelActions}
              onClose={() => setLabelsOpen(false)}
            />
          </PopoverContent>
        </Popover>
        <button
          type="button"
          className="task-editor-delete"
          aria-label="Delete task"
          onClick={handleDelete}
        >
          <Trash2 size={14} />
          Delete
        </button>
      </div>
    </div>
  );
}
