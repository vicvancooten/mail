import { Pictogram } from "../brand/Pictogram.js";
import type { CachedThread } from "../store/index.js";
import type { OnReply } from "./ThreadDetailPane.js";
import { ThreadDetailPane } from "./ThreadDetailPane.js";
import { neighborId } from "./thread-navigation.js";
import { PINNED_GROUP_LABEL, timeGroupLabel } from "./time-groups.js";
import type { Triage } from "./useTriage.js";

const PEEK_RADIUS = 3;

/**
 * Stream mode (`?stream=1` on the prototype branch): no list at all, one
 * Thread fills the screen with a thin peek strip previewing what's next.
 * Keyboard navigation (`h`/`j`/`k`/`l`, the flanking chevrons) and triage
 * (archive/trash/star/read) are both `useTriage`'s job now (#42), bound
 * once in `MailSection` — this view only renders off `selectedThreadId`
 * and the four actions it's handed, the same as Split/List.
 */
export function StreamView({
  threads,
  ids,
  selectedThreadId,
  onSelect,
  onBack,
  triage,
  onReply,
}: {
  threads: readonly CachedThread[];
  ids: readonly string[];
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  /** Present when the underlying view mode has a list to fall back to. */
  onBack?: () => void;
  triage: Triage;
  onReply: OnReply;
}) {
  const currentId = selectedThreadId ?? ids[0] ?? null;
  const currentThread = threads.find((thread) => thread.id === currentId) ?? null;
  const prevId = neighborId(ids, currentId, -1);
  const nextId = neighborId(ids, currentId, 1);

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
              className={`chip${thread.id === currentThread.id ? " current" : ""}${thread.pinned ? " pinned" : ""}`}
              onClick={() => onSelect(thread.id)}
            >
              {thread.pinned ? <Pictogram name="pin" size={11} /> : null}
              {thread.participants[0]?.name ?? thread.participants[0]?.address ?? "(no sender)"}
            </button>
          ))}
        </div>
      ) : null}
      <ThreadDetailPane
        key={currentThread.id}
        thread={currentThread}
        groupLabel={
          // Pinned surfaces prominently in Stream mode too (#43): the same
          // synthetic "Pinned" label `groupThreadsByTime` gives it in
          // Split/List, instead of whatever date bucket it would otherwise
          // fall into.
          currentThread.pinned
            ? PINNED_GROUP_LABEL
            : timeGroupLabel(currentThread.lastMessageAt ?? currentThread.firstMessageAt)
        }
        onBack={onBack}
        onPrev={prevId ? () => onSelect(prevId) : undefined}
        onNext={nextId ? () => onSelect(nextId) : undefined}
        triage={triage}
        onReply={onReply}
      />
    </div>
  );
}
