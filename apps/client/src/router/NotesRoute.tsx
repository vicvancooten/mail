import { Outlet } from "@tanstack/react-router";
import { NotesGrid } from "../notes/NotesGrid.js";

/**
 * `/notes`'s layout route (#193, Foundations' path-param routing rule's
 * first real caller): the grid is this route's own content, always mounted —
 * a deep link to `/notes/:noteId` opens straight into the dialog over it,
 * never a blank intermediate page. `<Outlet/>` is where `notesNoteRoute`'s
 * own dialog (`NoteDialogRoute.tsx`) renders when `$noteId` matches; there is
 * nothing here tracking which Note (if any) is open — that state is the
 * router's match, not this component's.
 */
export function NotesRoute() {
  return (
    <>
      <NotesGrid />
      <Outlet />
    </>
  );
}
