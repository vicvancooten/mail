import type { CachedThread } from "../store/index.js";
import { ThreadDetailPane } from "./ThreadDetailPane.js";
import { neighborId } from "./thread-navigation.js";
import type { Triage } from "./useTriage.js";
import { VirtualizedThreadList } from "./VirtualizedThreadList.js";

/**
 * Split view (default, `?variant=A` on the prototype branch): list and
 * reading pane side by side, always in sync — opening a Thread is just
 * selecting it, the same move `j`/`k` makes.
 */
export function SplitView({
  threads,
  ids,
  complete,
  selectedThreadId,
  onSelect,
  onLoadMore,
  triage,
}: {
  threads: readonly CachedThread[];
  ids: readonly string[];
  complete: boolean;
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  onLoadMore?: () => void;
  triage: Triage;
}) {
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const prevId = neighborId(ids, selectedThreadId, -1);
  const nextId = neighborId(ids, selectedThreadId, 1);

  return (
    <div className="split-view">
      <div className="split-list">
        <VirtualizedThreadList
          threads={threads}
          complete={complete}
          selectedThreadId={selectedThreadId}
          onSelect={onSelect}
          onLoadMore={onLoadMore}
        />
      </div>
      <div className="split-pane">
        {selectedThread ? (
          <ThreadDetailPane
            thread={selectedThread}
            onPrev={prevId ? () => onSelect(prevId) : undefined}
            onNext={nextId ? () => onSelect(nextId) : undefined}
            triage={triage}
          />
        ) : (
          <p className="mail-empty">Select a thread to read it.</p>
        )}
      </div>
    </div>
  );
}
