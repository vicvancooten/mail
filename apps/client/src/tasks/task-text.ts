import type { Task } from "@mail/shared";
import { flattenDocumentText } from "../notes/note-text.js";

/**
 * A Task's own searchable text (#262: the Command Palette's local hits and
 * the Tasks App's own "See all results" chip) — title plus the body's
 * flattened text, "a hit can come from the title or any block" (the
 * ticket's own words). Unlike a Note, a Task always carries a real `title`
 * field (`@mail/shared#taskSchema`), so there's no "derive one from the
 * first block" step the way `notes/note-text.ts#deriveNoteTitle` needs —
 * `flattenDocumentText` is reused as-is since `Task.document` and
 * `Note.document` are the same `NoteDocument` shape.
 */
export function taskSearchText(task: Task): string {
  return `${task.title} ${flattenDocumentText(task.document)}`;
}
