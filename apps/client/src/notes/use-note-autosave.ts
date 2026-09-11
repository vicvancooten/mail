import type { NoteDocument } from "@mail/shared";
import { useCallback, useEffect, useRef } from "react";
import { saveNoteBody } from "../store/notes.js";

/**
 * The Client's own local-write debounce for a Note's body (#192, ADR-0023) —
 * the same value, and the same reasoning, as `compose/Composer.tsx`'s own
 * `AUTOSAVE_DEBOUNCE_MS`: the `documentSaves` channel is modelled directly on
 * Composer's autosave.
 */
export const AUTOSAVE_DEBOUNCE_MS = 400;

/**
 * Wires a Note editor's `onChange` (`notes/NoteEditor.tsx`'s own prop) into
 * the `documentSaves` channel: every call schedules a debounced write, and a
 * call before the timer fires simply reschedules it — `Composer.tsx`'s
 * `scheduleAutosave` shape exactly, lifted into a reusable hook since a
 * Note editor, unlike the docked Composer, is meant to be embedded from more
 * than one place (a dialog now, the Command Palette's inline preview later).
 * "Replace, never stack" past that point is `saveNoteBody`'s own `put()`
 * upsert (`store/notes.ts`'s doc comment) — this hook only owns the local
 * timing, not the coalescing.
 *
 * `flush` (#193) is this ticket's own answer to the gap this file's earlier
 * doc comment left open: the Note dialog's close path calls it before
 * navigating away, so the last keystroke inside the debounce window is never
 * silently dropped — "no 'done editing' step" (#193's own acceptance line)
 * still holds, since this is a courtesy the *close* path takes, not a save
 * button the User ever sees or waits on. Unmounting without calling `flush`
 * (the cleanup effect below) still drops whatever was pending, unchanged
 * from before — a leftover debounce must never fire against a Note the
 * caller has already stopped rendering.
 */
export function useNoteAutosave(noteId: string): {
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
        if (scheduled) void saveNoteBody(noteId, scheduled);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [noteId],
  );

  const flush = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const scheduled = pendingRef.current;
    pendingRef.current = null;
    if (scheduled) void saveNoteBody(noteId, scheduled);
  }, [noteId]);

  return { onChange, flush };
}
