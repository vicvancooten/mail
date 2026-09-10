import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog.js";
import { type CachedThread, useRecentThreadsForLinking } from "../store/index.js";
import "./notes.css";

/**
 * The Thread Link slash-menu item's own picker (#195): a Thread Link's
 * props are a whole Thread's snapshot, and nothing at slash-menu-click time
 * knows which Thread that is — unlike "Add to Notes" (the Reader already
 * has one open), typing `/` inside an arbitrary Note doesn't. This is the
 * small search-and-pick surface that stands in for a Thread argument the
 * slash menu itself has no way to carry, the same "filter box + list" shape
 * `mail/LabelPicker.tsx` already gives Label's own picker, just over
 * `useRecentThreadsForLinking` (`store/reads.ts`) instead of the User's
 * Labels.
 *
 * A shadcn `Dialog` rather than a Popover (`NoteDialog.tsx`/
 * `ScreenerViewDialog.tsx`'s own precedent): the slash menu has already
 * closed and its own anchor element is gone by the time this opens, so
 * there is nothing left to position a Popover against.
 */
export function ThreadLinkPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (thread: CachedThread) => void;
}) {
  const [query, setQuery] = useState("");
  const threads = useRecentThreadsForLinking();

  const filtered = useMemo(() => {
    if (!threads) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) => {
      if (thread.subject.toLowerCase().includes(needle)) return true;
      return thread.participants.some((p) => (p.name ?? p.address).toLowerCase().includes(needle));
    });
  }, [threads, query]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
    >
      <DialogContent className="thread-link-picker">
        <DialogTitle>Link a Thread</DialogTitle>
        <label className="thread-link-picker-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Threads by subject or participant…"
            aria-label="Search Threads"
            autoFocus
          />
        </label>
        {threads === undefined ? null : filtered.length === 0 ? (
          <p className="thread-link-picker-empty">
            {threads.length === 0 ? "No Threads cached yet." : "No Threads match."}
          </p>
        ) : (
          <ul className="thread-link-picker-list">
            {filtered.map((thread) => (
              <li key={thread.id}>
                <button type="button" onClick={() => onPick(thread)}>
                  <span className="thread-link-picker-subject">
                    {thread.subject || "(no subject)"}
                  </span>
                  <span className="thread-link-picker-meta">
                    {thread.participants.map((p) => p.name ?? p.address).join(", ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
