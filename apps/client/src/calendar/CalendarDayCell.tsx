import type { DragEvent, MouseEvent, ReactNode, Ref } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../components/ui/context-menu.js";
import { TASK_DRAG_TYPE } from "../tasks/task-drag.js";
import type { CivilDate } from "./calendar-dates.js";
import { dayHeadingLabel } from "./calendar-dates.js";

/**
 * Right-click zooms in (#231's own acceptance line): every day cell across
 * Month, Week, Work Week and Year gets this same context menu — a plain
 * shadcn `ContextMenu` wrapping the cell's own content, "Go to Day" jumping
 * straight to Day view for that cell's date, never a bespoke handler per
 * grid. Day view itself never wraps a cell in this — there is nowhere left
 * to zoom into from there.
 *
 * `onTaskDrop` (#261) is this cell's own native-HTML5-drag drop target — a
 * dragged Task chip's payload (`tasks/task-drag.ts#TASK_DRAG_TYPE`) accepted
 * only where a caller passes it (the all-day row, Month's own day cells);
 * omitted here refuses every drop with the browser's own "not-allowed"
 * cursor and no `drop` ever firing — exactly the timed grid's own posture
 * (ADR-0030: a Task has no block of time to occupy there), for free, with no
 * extra styling of its own.
 *
 * `onBackgroundClick` (#261) fires only for a click that lands on this
 * cell's own empty background — `event.target === event.currentTarget`
 * guards it, so a click on a chip or the Month day-number button (both
 * nested descendants) never also opens the create popover behind them.
 */
export function CalendarDayCell({
  date,
  className,
  onOpenDay,
  onTaskDrop,
  onBackgroundClick,
  containerRef,
  children,
}: {
  date: CivilDate;
  className?: string;
  onOpenDay: (date: CivilDate) => void;
  onTaskDrop?: (taskId: string) => void;
  onBackgroundClick?: (event: MouseEvent<HTMLDivElement>) => void;
  /** The Event drag session's own hit-test (#305) — `DayTimeGrid.tsx`/`MonthGrid.tsx` collect one ref per cell so a pointer-move can find which cell it's currently over; `undefined` everywhere a cell is never itself a drag target. */
  containerRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!onTaskDrop || !event.dataTransfer.types.includes(TASK_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!onTaskDrop) return;
    const taskId = event.dataTransfer.getData(TASK_DRAG_TYPE);
    if (!taskId) return;
    event.preventDefault();
    onTaskDrop(taskId);
  }

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if (onBackgroundClick && event.target === event.currentTarget) onBackgroundClick(event);
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a native HTML5 drop zone and click-to-create surface (#261, "no drag-and-drop dependency") over the cell's own background — every real control here (a chip's checkbox/title, the Month day-number button) is its own focusable element right inside it; the click/drag are shortcuts, the chip's own popover Due control and the Tasks App's own create flow are the keyboard/screen-reader path. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: same shortcut-surface reasoning — there is no keyboard equivalent of "click empty grid space" to wire, the same posture `tasks/TaskListView.tsx`'s own drop zones already take. */}
        <div
          ref={containerRef}
          className={className}
          onClick={onBackgroundClick ? handleClick : undefined}
          onDragOver={onTaskDrop ? handleDragOver : undefined}
          onDrop={onTaskDrop ? handleDrop : undefined}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpenDay(date)}>
          Go to {dayHeadingLabel(date)}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
