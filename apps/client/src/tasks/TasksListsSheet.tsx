import type { TaskList } from "@mail/shared";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.js";
import { TasksSidebar } from "./TasksSidebar.js";
import type { TaskView } from "./task-view.js";
import { setTasksListsSheetOpen, useTasksListsSheetOpen } from "./tasks-lists-sheet.js";

/**
 * The phone Lists Sheet (#321): on phone the rail is never a second pane —
 * `TasksApp.tsx`'s own main column is always the screen, and this bottom
 * `Sheet` stands in for the always-visible desktop rail, opened by the
 * Dock's own Lists tile (`router/Dock.tsx#useNavControlAction`,
 * `tasks-lists-sheet.ts`'s module-level opener — `mail/Sidebar.tsx`'s own
 * `MobileSheet` is the desktop-rail/phone-sheet precedent this pairs with,
 * except Tasks has no *third* state to fall back to the way Mail's split
 * view does: picking a row here always lands the main pane on something,
 * `TasksApp.tsx`'s own Today default (#321) is what makes that true).
 *
 * Renders the identical `TasksSidebar` the desktop rail does — same Views,
 * Lists, "New list" row and Recently Deleted — with every selection
 * callback wrapped to close the Sheet right after, `mail/Sidebar.tsx#MobileSheet`'s
 * own `selectFolder`/`selectLabel` shape.
 */
export function TasksListsSheet({
  taskLists,
  selectedTaskListId,
  onSelectTaskList,
  selectedView,
  onSelectView,
  onOpenRecentlyDeleted,
}: {
  taskLists: readonly TaskList[];
  selectedTaskListId: string | null;
  onSelectTaskList: (id: string) => void;
  selectedView: TaskView | null;
  onSelectView: (view: TaskView) => void;
  onOpenRecentlyDeleted: () => void;
}) {
  const open = useTasksListsSheetOpen();

  function selectTaskList(id: string) {
    onSelectTaskList(id);
    setTasksListsSheetOpen(false);
  }

  function selectView(view: TaskView) {
    onSelectView(view);
    setTasksListsSheetOpen(false);
  }

  function openRecentlyDeleted() {
    onOpenRecentlyDeleted();
    setTasksListsSheetOpen(false);
  }

  return (
    <Sheet open={open} onOpenChange={setTasksListsSheetOpen}>
      <SheetContent side="bottom" className="tasks-lists-sheet">
        <SheetHeader className="sr-only">
          <SheetTitle>Lists</SheetTitle>
          <SheetDescription>Choose a view or a Task List.</SheetDescription>
        </SheetHeader>
        <TasksSidebar
          taskLists={taskLists}
          selectedTaskListId={selectedTaskListId}
          onSelectTaskList={selectTaskList}
          selectedView={selectedView}
          onSelectView={selectView}
          onOpenRecentlyDeleted={openRecentlyDeleted}
        />
      </SheetContent>
    </Sheet>
  );
}
