import type { NoteDocument } from "@mail/shared";
import { useCallback, useEffect, useRef } from "react";
import { saveNoteBody } from "../store/notes.js";

/**
 * The Client's own local-write debounce for a Note's body (#192, ADR-0023) —
 * the same value, and the same reasoning, as `compose/Composer.tsx`'s own
 * `AUTOSAVE_DEBOUNCE_MS`: the `noteSaves` channel is modelled directly on
 * Composer's autosave.
 */
export const AUTOSAVE_DEBOUNCE_MS = 400;

/**
 * Wires a Note editor's `onChange` (`notes/NoteEditor.tsx`'s own prop) into
 * the `noteSaves` channel: every call schedules a debounced write, and a
 * call before the timer fires simply reschedules it — `Composer.tsx`'s
 * `scheduleAutosave` shape exactly, lifted into a reusable hook since a
 * Note editor, unlike the docked Composer, is meant to be embedded from more
 * than one place (a dialog now, the Command Palette's inline preview later).
 * "Replace, never stack" past that point is `saveNoteBody`'s own `put()`
 * upsert (`store/notes.ts`'s doc comment) — this hook only owns the local
 * timing, not the coalescing.
 *
 * A pending debounce must never survive the component that owns it: the
 * cleanup effect below mirrors `Composer.tsx`'s own unmount guard so a
 * leftover timer can never fire against a Note the caller has since closed.
 * Unlike Composer's own `flushAndClose`, there is no final un-debounced
 * write on unmount here — a Note editor's own close path (#193) decides
 * whether that final flush is its job or this hook's; forcing one here would
 * assume a `document` this hook was never handed.
 */
export function useNoteAutosave(noteId: string): (document: NoteDocument) => void {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  return useCallback(
    (document: NoteDocument) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void saveNoteBody(noteId, document);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [noteId],
  );
}
