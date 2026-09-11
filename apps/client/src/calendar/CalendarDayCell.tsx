import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../components/ui/context-menu.js";
import type { CivilDate } from "./calendar-dates.js";
import { dayHeadingLabel } from "./calendar-dates.js";

/**
 * Right-click zooms in (#231's own acceptance line): every day cell across
 * Month, Week, Work Week and Year gets this same context menu — a plain
 * shadcn `ContextMenu` wrapping the cell's own content, "Go to Day" jumping
 * straight to Day view for that cell's date, never a bespoke handler per
 * grid. Day view itself never wraps a cell in this — there is nowhere left
 * to zoom into from there.
 */
export function CalendarDayCell({
  date,
  className,
  onOpenDay,
  children,
}: {
  date: CivilDate;
  className?: string;
  onOpenDay: (date: CivilDate) => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={className}>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpenDay(date)}>
          Go to {dayHeadingLabel(date)}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
