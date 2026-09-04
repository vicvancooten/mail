import { Mark } from "../brand/Mark.js";
import type { CachedThread } from "../store/index.js";
import type { ListDensity } from "./device-preferences.js";
import type { MailtoLink } from "./reading/mailto.js";
import type { OnReply } from "./ThreadDetailPane.js";
import { ThreadDetailPane } from "./ThreadDetailPane.js";
import { neighborId } from "./thread-navigation.js";
import type { Triage } from "./useTriage.js";
import { type GroupBulkController, VirtualizedThreadList } from "./VirtualizedThreadList.js";

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
  onMailtoLink,
  initialScrollThreadId,
  density,
  groupBulk,
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
  onMailtoLink: (link: MailtoLink) => void;
  /** Passed straight through to `VirtualizedThreadList` — see its own doc comment (#51). */
  initialScrollThreadId?: string | null;
  /** Passed straight through to `VirtualizedThreadList` — the `compact` List Density Device Preference (#54, #75). */
  density?: ListDensity;
  /** Passed straight through to `VirtualizedThreadList` — the group header cluster (#66, #77). */
  groupBulk?: GroupBulkController;
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
          groupBulk={groupBulk}
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
            onMailtoLink={onMailtoLink}
          />
        ) : (
          // The comp's `.caught-up`: an accent-soft disc, one line saying
          // where you are, and — the product's own addition, since the comp
          // has no keyboard to teach — the six bindings the triage loop is
          // actually built around.
          <div className="pane-empty">
            <span className="pane-empty-mark">
              <Mark size={24} />
            </span>
            <h2>Nothing open</h2>
            <p>Pick a thread, or clear the day from the keyboard.</p>
            <dl className="pane-keys">
              <dt>
                <kbd className="keycap">J</kbd>
              </dt>
              <dd>next thread</dd>
              <dt>
                <kbd className="keycap">K</kbd>
              </dt>
              <dd>previous</dd>
              <dt>
                <kbd className="keycap">E</kbd>
              </dt>
              <dd>done</dd>
              <dt>
                <kbd className="keycap">S</kbd>
              </dt>
              <dd>star</dd>
              <dt>
                <kbd className="keycap">L</kbd>
              </dt>
              <dd>label</dd>
              <dt>
                <kbd className="keycap">C</kbd>
              </dt>
              <dd>compose</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
