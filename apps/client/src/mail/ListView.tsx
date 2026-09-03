import type { CachedThread } from "../store/index.js";
import type { ListDensity } from "./device-preferences.js";
import type { OnReply } from "./ThreadDetailPane.js";
import { ThreadDetailPane } from "./ThreadDetailPane.js";
import { neighborId } from "./thread-navigation.js";
import type { Triage } from "./useTriage.js";
import { VirtualizedThreadList } from "./VirtualizedThreadList.js";

/**
 * List view (`?variant=B` on the prototype branch): one pane. Opening a
 * Thread swaps the list for a full-screen detail view rather than sitting
 * beside it — `onBack` (rendered as a fixed pill, per Vic's feedback that
 * the prototype's text link was too easy to miss) returns to the list.
 */
export function ListView({
  threads,
  ids,
  complete,
  selectedThreadId,
  onSelect,
  onBack,
  onLoadMore,
  triage,
  onReply,
  initialScrollThreadId,
  density,
}: {
  threads: readonly CachedThread[];
  ids: readonly string[];
  complete: boolean;
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  onBack: () => void;
  onLoadMore?: () => void;
  triage: Triage;
  onReply: OnReply;
  /** Passed straight through to `VirtualizedThreadList` — see its own doc comment (#51). */
  initialScrollThreadId?: string | null;
  /** Passed straight through to `VirtualizedThreadList` — the `compact` List Density Device Preference (#54, #75). */
  density?: ListDensity;
}) {
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;

  if (selectedThread) {
    const prevId = neighborId(ids, selectedThreadId, -1);
    const nextId = neighborId(ids, selectedThreadId, 1);
    return (
      <ThreadDetailPane
        key={selectedThread.id}
        thread={selectedThread}
        onBack={onBack}
        onPrev={prevId ? () => onSelect(prevId) : undefined}
        onNext={nextId ? () => onSelect(nextId) : undefined}
        triage={triage}
        onReply={onReply}
      />
    );
  }

  return (
    <VirtualizedThreadList
      threads={threads}
      complete={complete}
      selectedThreadId={selectedThreadId}
      onSelect={onSelect}
      onLoadMore={onLoadMore}
      triage={triage}
      initialScrollThreadId={initialScrollThreadId}
      density={density}
    />
  );
}
