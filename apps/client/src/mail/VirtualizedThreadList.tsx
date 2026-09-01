import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CachedThread } from "../store/index.js";
import { ThreadRow } from "./ThreadRow.js";
import { groupThreadsByTime } from "./time-groups.js";

/**
 * The windowed, time-grouped list (#40). Renders only the rows in and near
 * the viewport regardless of how many Threads the page holds — what makes
 * the list stay smooth against the 250k-message / 80k-thread corpus
 * account, since the Local Cache's own window already bounds what's held
 * to a ~500-thread floor (ADR-0009) and this bounds what's ever mounted.
 */

type ListItem =
  | { kind: "header"; key: string; label: string }
  | { kind: "thread"; key: string; thread: CachedThread; index: number };

const HEADER_HEIGHT = 32;
const ROW_HEIGHT = 60;
/** How close to the bottom (in rows) triggers widening the requested page. */
const LOAD_MORE_THRESHOLD = 10;

export function VirtualizedThreadList({
  threads,
  complete,
  selectedThreadId,
  onSelect,
  onLoadMore,
}: {
  threads: readonly CachedThread[];
  /** False once the window has been truncated at the bottom (ADR-0009). */
  complete: boolean;
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  /** Requests a wider page — called once as the viewport nears the bottom. */
  onLoadMore?: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const items = useMemo<ListItem[]>(() => {
    const groups = groupThreadsByTime(threads);
    const flat: ListItem[] = [];
    let index = 0;
    for (const group of groups) {
      flat.push({ kind: "header", key: `header:${group.label}:${index}`, label: group.label });
      for (const thread of group.threads) {
        flat.push({ kind: "thread", key: thread.id, thread, index });
        index += 1;
      }
    }
    return flat;
  }, [threads]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (items[index]?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
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
  }, [moveSelection]);

  if (threads.length === 0) {
    return <p className="mail-empty">No mail cached for this account yet.</p>;
  }

  return (
    <div className="thread-list" ref={parentRef} role="listbox" aria-label="Threads">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualItems.map((virtualItem) => {
          const item = items[virtualItem.index];
          if (!item) return null;
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
                  index={item.index}
                />
              )}
            </div>
          );
        })}
      </div>
      {complete ? null : <p className="mail-list-footer">Older mail needs a connection.</p>}
    </div>
  );
}
