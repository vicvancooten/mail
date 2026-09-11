/**
 * The two date-driven views (#254): Today and Upcoming, both list-only and
 * both sitting above the Lists in the sidebar — `TasksSidebar.tsx`'s own
 * nav, `TasksApp.tsx`'s own main-column branch, and `router/routes.tsx`'s
 * own `?view=` (reserved by #253 for exactly this). A shared type + display
 * name here rather than a literal string repeated in each of those three
 * places.
 */
export type TaskView = "today" | "upcoming";

export const TASK_VIEWS: { id: TaskView; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
];
