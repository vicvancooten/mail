import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import type { CachedThread } from "../store/index.js";
import { ThreadRow } from "./ThreadRow.js";
import { groupThreadsByTime } from "./time-groups.js";
import type { Triage } from "./useTriage.js";

/**
 * The windowed list (#40, and #51's "one list renderer... search is another
 * list, not a second application"). Renders only the rows in and near the
 * viewport regardless of how many Threads the page holds — what makes the
 * list stay smooth against the 250k-message / 80k-thread corpus account,
 * since the Local Cache's own window already bounds what's held to a
 * ~500-thread floor (ADR-0009) and this bounds what's ever mounted.
 *
 * `group` (default `true`) is search's one structural opt-out: "Ranked and
 * ungrouped. No time-grouping headers — the triage list's chronological
 * grouping under a relevance order is actively confusing" (search-ux-
 * spec.md §The result list). `getRowExtra`/`footer` are the row/foot
 * decorations that section also asks for; every prop here defaults to
 * exactly today's behavior, so #40's own callers are unaffected.
 */

type ListItem =
  | { kind: "header"; key: string; label: string }
  | { kind: "thread"; key: string; thread: CachedThread; index: number };

const HEADER_HEIGHT = 32;
/** The default (`comfortable`) row height — `rowHeight` overrides it for the `compact` list density (#54, Device Preference). */
const ROW_HEIGHT = 60;
/** `mail.css`'s `.thread-list--compact .thread-row` row height — kept as one exported constant so the two never drift apart. */
export const COMPACT_ROW_HEIGHT = 40;
/** How close to the bottom (in rows) triggers widening the requested page. */
const LOAD_MORE_THRESHOLD = 10;

export interface RowExtra {
  headline?: string | null;
  folderPill?: string | null;
  actionBadge?: string | null;
}

export function VirtualizedThreadList({
  threads,
  complete,
  selectedThreadId,
  onSelect,
  onLoadMore,
  triage,
  group = true,
  footer,
  getRowExtra,
  keyboardDisabled = false,
  initialScrollThreadId = null,
  rowHeight = ROW_HEIGHT,
}: {
  threads: readonly CachedThread[];
  /** False once the window has been truncated at the bottom (ADR-0009). */
  complete: boolean;
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  /** Requests a wider page — called once as the viewport nears the bottom. */
  onLoadMore?: () => void;
  /** Present wires each row's swipe-to-archive/-trash (#44); omitted, rows render with no swipe affordance. */
  triage?: Triage;
  /** `false` for search's ranked, ungrouped result list (search-ux-spec.md §The result list). */
  group?: boolean;
  /** Overrides the default "Older mail needs a connection." foot line — search's "Load older results" + Index Watermark (search-ux-spec.md §The foot of the list). */
  footer?: ReactNode;
  /** Per-row decorations (headline, folder pill, action badge) — search-only; every other caller leaves this unset. */
  getRowExtra?: (thread: CachedThread) => RowExtra | undefined;
  /** Skips this list's own `j`/`k` keydown listener — for a copy of the list left mounted-but-hidden behind another surface (#51's search route swap) so it doesn't fight that surface's own keyboard handling. */
  keyboardDisabled?: boolean;
  /** Scrolls this Thread into view once, on mount — #51's "leaving [search] restores... its scroll position" (search-ux-spec.md), approximated as "the Thread you had open is back in view" rather than a raw pixel offset. */
  initialScrollThreadId?: string | null;
  /** The `compact` list density's row height (#54, Device Preference) — every other caller keeps the `comfortable` default. */
  rowHeight?: number;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const items = useMemo<ListItem[]>(() => {
    if (!group) {
      return threads.map((thread, index) => ({
        kind: "thread" as const,
        key: thread.id,
        thread,
        index,
      }));
    }
    const groups = groupThreadsByTime(threads);
    const flat: ListItem[] = [];
    let index = 0;
    for (const groupItem of groups) {
      flat.push({
        kind: "header",
        key: `header:${groupItem.label}:${index}`,
        label: groupItem.label,
      });
      for (const thread of groupItem.threads) {
        flat.push({ kind: "thread", key: thread.id, thread, index });
        index += 1;
      }
    }
    return flat;
  }, [threads, group]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (items[index]?.kind === "header" ? HEADER_HEIGHT : rowHeight),
    overscan: 12,
    // A real browser's ResizeObserver corrects this immediately; it only
    // matters where none exists — jsdom under `pnpm test`, which otherwise
    // measures every element's height as 0 and renders nothing.
    initialRect: { width: 400, height: 600 },
  });

  const virtualItems = virtualizer.getVirtualItems();
  const lastVirtualIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;

  useEffect(() => {
    if (!onLoadMore || complete) return;
    if (lastVirtualIndex >= items.length - LOAD_MORE_THRESHOLD) onLoadMore();
  }, [lastVirtualIndex, items.length, complete, onLoadMore]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately once-on-mount — see the prop doc comment.
  useEffect(() => {
    if (!initialScrollThreadId) return;
    const itemIndex = items.findIndex(
      (item) => item.kind === "thread" && item.thread.id === initialScrollThreadId,
    );
    if (itemIndex !== -1) virtualizer.scrollToIndex(itemIndex, { align: "auto" });
  }, []);

  const threadIds = useMemo(
    () => items.filter((item) => item.kind === "thread").map((item) => item.thread.id),
    [items],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (threadIds.length === 0) return;
      const currentIndex = selectedThreadId ? threadIds.indexOf(selectedThreadId) : -1;
      const nextIndex =
        currentIndex === -1 ? 0 : Math.min(Math.max(currentIndex + delta, 0), threadIds.length - 1);
      const nextId = threadIds[nextIndex];
      if (nextId) {
        onSelect(nextId);
        const itemIndex = items.findIndex(
          (item) => item.kind === "thread" && item.thread.id === nextId,
        );
        if (itemIndex !== -1) virtualizer.scrollToIndex(itemIndex, { align: "auto" });
      }
    },
    [threadIds, selectedThreadId, onSelect, items, virtualizer],
  );

  useEffect(() => {
    if (keyboardDisabled) return;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [moveSelection, keyboardDisabled]);

  if (threads.length === 0) {
    return <p className="mail-empty">No mail cached for this account yet.</p>;
  }

  return (
    <div
      className={`thread-list${rowHeight !== ROW_HEIGHT ? " thread-list--compact" : ""}`}
      ref={parentRef}
      role="listbox"
      aria-label="Threads"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualItems.map((virtualItem) => {
          const item = items[virtualItem.index];
          if (!item) return null;
          const extra = item.kind === "thread" ? getRowExtra?.(item.thread) : undefined;
          return (
            <div
              key={item.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {item.kind === "header" ? (
                <div className="group-header">{item.label}</div>
              ) : (
                <ThreadRow
                  thread={item.thread}
                  selected={item.thread.id === selectedThreadId}
                  onSelect={() => onSelect(item.thread.id)}
                  onArchive={triage ? () => triage.archive(item.thread.id) : undefined}
                  onTrash={triage ? () => triage.trash(item.thread.id) : undefined}
                  index={item.index}
                  headline={extra?.headline}
                  folderPill={extra?.folderPill}
                  actionBadge={extra?.actionBadge}
                />
              )}
            </div>
          );
        })}
      </div>
      {footer !== undefined ? (
        footer
      ) : complete ? null : (
        <p className="mail-list-footer">Older mail needs a connection.</p>
      )}
    </div>
  );
}
