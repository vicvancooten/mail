import { useEffect } from "react";
import type { CachedThread } from "../store/index.js";
import { ThreadDetailPane } from "./ThreadDetailPane.js";
import { neighborId } from "./thread-navigation.js";
import { timeGroupLabel } from "./time-groups.js";

const PEEK_RADIUS = 3;

/**
 * Stream mode (`?stream=1` on the prototype branch): no list at all, one
 * Thread fills the screen with a thin peek strip previewing what's next.
 * Browsing the queue (`h`/`l`, the flanking chevrons) is deliberately
 * separate from resolving a Thread (archive/trash/etc., #42's job) — this
 * view only ever moves the selection.
 */
export function StreamView({
  threads,
  ids,
  selectedThreadId,
  onSelect,
  onBack,
}: {
  threads: readonly CachedThread[];
  ids: readonly string[];
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  /** Present when the underlying view mode has a list to fall back to. */
  onBack?: () => void;
}) {
  const currentId = selectedThreadId ?? ids[0] ?? null;
  const currentThread = threads.find((thread) => thread.id === currentId) ?? null;
  const prevId = neighborId(ids, currentId, -1);
  const nextId = neighborId(ids, currentId, 1);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      if (event.key === "h" || event.key === "ArrowLeft") {
        if (prevId) {
          event.preventDefault();
          onSelect(prevId);
        }
      } else if (event.key === "l" || event.key === "ArrowRight") {
        if (nextId) {
          event.preventDefault();
          onSelect(nextId);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prevId, nextId, onSelect]);

  if (!currentThread) {
    return <p className="mail-empty">No mail cached for this account yet.</p>;
  }

  const currentIndex = currentId ? ids.indexOf(currentId) : -1;
  const peekIds = ids.slice(
    Math.max(0, currentIndex - PEEK_RADIUS),
    currentIndex + PEEK_RADIUS + 1,
  );
  const peekThreads = peekIds
    .map((id) => threads.find((thread) => thread.id === id))
    .filter((thread): thread is CachedThread => thread !== undefined);

  return (
    <div className="stream-view">
      {peekThreads.length > 0 ? (
        <div className="queue-peek">
          {peekThreads.map((thread) => (
            <button
              type="button"
              key={thread.id}
              className={`chip${thread.id === currentThread.id ? " current" : ""}`}
              onClick={() => onSelect(thread.id)}
            >
              {thread.participants[0]?.name ?? thread.participants[0]?.address ?? "(no sender)"}
            </button>
          ))}
        </div>
      ) : null}
      <ThreadDetailPane
        thread={currentThread}
        groupLabel={timeGroupLabel(currentThread.lastMessageAt ?? currentThread.firstMessageAt)}
        onBack={onBack}
        onPrev={prevId ? () => onSelect(prevId) : undefined}
        onNext={nextId ? () => onSelect(nextId) : undefined}
      />
    </div>
  );
}
