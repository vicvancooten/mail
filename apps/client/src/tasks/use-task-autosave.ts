import type { NoteDocument } from "@mail/shared";
import { useCallback, useEffect, useRef } from "react";
import { saveTaskBody } from "../store/tasks.js";

/**
 * The Client's own local-write debounce for a Task's body (#253, #250,
 * ADR-0023) — `notes/use-note-autosave.ts`'s exact sibling, over
 * `saveTaskBody` instead of `saveNoteBody`. See that file's own doc comment
 * for the full reasoning (`AUTOSAVE_DEBOUNCE_MS`, `flush`'s own purpose);
 * this is deliberately not a shared hook parameterized by collection —
 * two collections riding the same channel is `documentSaveSchema`'s own
 * shape (ADR-0023), not a reason for their Client-side autosave hooks to be
 * one function.
 */
export const AUTOSAVE_DEBOUNCE_MS = 400;

export function useTaskAutosave(taskId: string): {
  onChange: (document: NoteDocument) => void;
  flush: () => void;
} {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<NoteDocument | null>(null);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const onChange = useCallback(
    (document: NoteDocument) => {
      pendingRef.current = document;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        const scheduled = pendingRef.current;
        pendingRef.current = null;
        if (scheduled) void saveTaskBody(taskId, scheduled);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [taskId],
  );

  const flush = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const scheduled = pendingRef.current;
    pendingRef.current = null;
    if (scheduled) void saveTaskBody(taskId, scheduled);
  }, [taskId]);

  return { onChange, flush };
}
