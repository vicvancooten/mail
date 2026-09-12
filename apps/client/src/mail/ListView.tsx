import type { CachedThread } from "../store/index.js";
import type { ListDensity } from "./device-preferences.js";
import type { MailtoLink } from "./reading/mailto.js";
import type { OnReply } from "./ThreadDetailPane.js";
import { ThreadDetailPane } from "./ThreadDetailPane.js";
import { neighborId } from "./thread-navigation.js";
import type { Triage } from "./useTriage.js";
import { type GroupBulkController, VirtualizedThreadList } from "./VirtualizedThreadList.js";

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
  onOpenSheet,
  onBack,
  onLoadMore,
  triage,
  onReply,
  onMailtoLink,
  onOpenTask,
  initialScrollThreadId,
  scrollRestoreKey,
  density,
  groupBulk,
}: {
  threads: readonly CachedThread[];
  ids: readonly string[];
  complete: boolean;
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  /** Double-clicking a row opens the Reader Sheet (#292) over the list rather than swapping to the full-screen pane this view mode otherwise would on a single click — `SplitView`'s own doc comment on the prop. */
  onOpenSheet?: (id: string) => void;
  onBack: () => void;
  onLoadMore?: () => void;
  triage: Triage;
  onReply: OnReply;
  onMailtoLink: (link: MailtoLink) => void;
  onOpenTask: (taskId: string) => void;
  /** Passed straight through to `VirtualizedThreadList` — see its own doc comment (#51). */
  initialScrollThreadId?: string | null;
  /** Passed straight through to `VirtualizedThreadList` (#142) — the list unmounts here the moment a Thread opens, which is exactly the case its own doc comment calls out. */
  scrollRestoreKey?: string | null;
  /** Passed straight through to `VirtualizedThreadList` — the `compact` List Density Device Preference (#54, #75). */
  density?: ListDensity;
  /** Passed straight through to `VirtualizedThreadList` — the group header cluster (#66, #77). */
  groupBulk?: GroupBulkController;
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
        onMailtoLink={onMailtoLink}
        onOpenTask={onOpenTask}
      />
    );
  }

  return (
    <VirtualizedThreadList
      threads={threads}
      complete={complete}
      selectedThreadId={selectedThreadId}
      onSelect={onSelect}
      onOpenSheet={onOpenSheet}
      onLoadMore={onLoadMore}
      triage={triage}
      initialScrollThreadId={initialScrollThreadId}
      scrollRestoreKey={scrollRestoreKey}
      density={density}
      groupBulk={groupBulk}
    />
  );
}
