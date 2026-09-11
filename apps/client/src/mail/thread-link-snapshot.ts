import type { TaskThreadLink } from "@mail/shared";
import type { CachedThread } from "../store/index.js";

/**
 * A Thread's Thread Link snapshot (#195/#258) — the same `subject`/
 * `participants`/`date` derivation `MailSection.tsx`'s own `onAddToNotes`
 * and `ThreadDetailPane.tsx`'s header already give, shared here (rather
 * than a copy per caller) since both "Add to Tasks" call sites
 * (`MailSection.tsx`, `stream/StreamStack.tsx`) need the exact same triple,
 * handed to `store/tasks.ts#createTaskFromThreadLink` instead of
 * `store/notes.ts#createNoteFromThreadLink`. A module-level function rather
 * than a `useCallback` in each component: it closes over nothing, so it
 * never needs to be a hook dependency at all.
 */
export function threadLinkSnapshot(thread: CachedThread): TaskThreadLink {
  return {
    threadId: thread.id,
    subject: thread.subject || "(no subject)",
    participants: thread.participants.map((p) => p.name ?? p.address).join(", ") || "(no sender)",
    date: thread.lastMessageAt ?? new Date().toISOString(),
  };
}
