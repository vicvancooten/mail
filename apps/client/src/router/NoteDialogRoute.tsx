import { useCallback } from "react";
import { NoteDialog } from "../notes/NoteDialog.js";
import { notesNoteRoute, notesRoute } from "./routes.js";

/**
 * `/notes/$noteId`'s own route component (#193) — `MailRoute.tsx`'s own
 * "the one place that knows [the screen] lives at a route at all" shape,
 * `NoteDialog` itself stays router-agnostic. Closing (Esc, the close
 * control or a backdrop click, all funnelled through `NoteDialog`'s own
 * `onOpenChange`) navigates back to `/notes`, a `replace` — reopening a
 * different Note from the grid is a fresh forward navigation each time, not
 * a history entry per Note visited.
 *
 * `key={noteId}` forces a fresh `NoteDialog` (and the `NoteEditor`/
 * `useNoteAutosave` underneath it) whenever the matched `$noteId` itself
 * changes without the route ever unmounting — `NoteEditor`'s own doc
 * comment notes its `useCreateBlockNote` only reads `document` on mount, so
 * without this a Note opened directly from another Note's own dialog would
 * keep showing the first Note's content.
 */
export function NoteDialogRoute() {
  const { noteId } = notesNoteRoute.useParams();
  const navigate = notesRoute.useNavigate();
  const onClose = useCallback(() => {
    void navigate({ to: "/notes", replace: true });
  }, [navigate]);

  return <NoteDialog key={noteId} noteId={noteId} onClose={onClose} />;
}
