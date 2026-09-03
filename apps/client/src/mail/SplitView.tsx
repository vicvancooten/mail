import { Mark } from "../brand/Mark.js";
import type { CachedThread } from "../store/index.js";
import type { ListDensity } from "./device-preferences.js";
import type { OnReply } from "./ThreadDetailPane.js";
import { ThreadDetailPane } from "./ThreadDetailPane.js";
import { neighborId } from "./thread-navigation.js";
import type { Triage } from "./useTriage.js";
import { VirtualizedThreadList } from "./VirtualizedThreadList.js";

/**
 * Split view (default, `?variant=A` on the prototype branch): list and
 * reading pane side by side, always in sync — opening a Thread is just
 * selecting it, the same move `j`/`k` makes.
 *
 * `onClearSelection` (#44) backs the pane's "Back to list" pill, which
 * `mail.css` shows only under the narrow-viewport breakpoint: at desktop
 * widths both panes are visible at once and a way back to a list that's
 * already on screen would be redundant chrome, not a mobile-layout need.
 */
export function SplitView({
  threads,
  ids,
  complete,
  selectedThreadId,
  onSelect,
  onClearSelection,
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
  onClearSelection: () => void;
  onLoadMore?: () => void;
  triage: Triage;
  onReply: OnReply;
  /** Passed straight through to `VirtualizedThreadList` — see its own doc comment (#51). */
  initialScrollThreadId?: string | null;
  /** Passed straight through to `VirtualizedThreadList` — the `compact` List Density Device Preference (#54, #75). */
  density?: ListDensity;
}) {
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const prevId = neighborId(ids, selectedThreadId, -1);
  const nextId = neighborId(ids, selectedThreadId, 1);

  return (
    // `has-selection` (#44) is a mobile-layout hook only — `mail.css`'s
    // narrow-viewport media query uses it to show list *or* pane full-width
    // rather than the desktop side-by-side split a phone has no room for;
    // it does nothing at desktop widths.
    <div className={`split-view${selectedThread ? " has-selection" : ""}`}>
      <div className="split-list">
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
      </div>
      <div className="split-pane">
        {selectedThread ? (
          <ThreadDetailPane
            key={selectedThread.id}
            thread={selectedThread}
            onBack={onClearSelection}
            onPrev={prevId ? () => onSelect(prevId) : undefined}
            onNext={nextId ? () => onSelect(nextId) : undefined}
            triage={triage}
            onReply={onReply}
          />
        ) : (
          <div className="pane-empty">
            <Mark size={34} />
            <p>Nothing open</p>
            <dl className="pane-keys">
              <dt>J</dt>
              <dd>next thread</dd>
              <dt>K</dt>
              <dd>previous</dd>
              <dt>E</dt>
              <dd>archive</dd>
              <dt>S</dt>
              <dd>star</dd>
              <dt>L</dt>
              <dd>label</dd>
              <dt>C</dt>
              <dd>compose</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
