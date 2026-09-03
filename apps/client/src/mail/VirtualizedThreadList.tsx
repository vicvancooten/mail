import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pictogram } from "../brand/Pictogram.js";
import type { CachedThread } from "../store/index.js";
import {
  DEFAULT_LIST_DENSITY,
  type ListDensity,
  readGroupCollapsed,
  writeGroupCollapsed,
} from "./device-preferences.js";
import { ThreadRow } from "./ThreadRow.js";
import { taperHeaderHeight, taperRowHeight, ungroupedRowHeight } from "./taper.js";
import { groupThreadsByTime, PINNED_GROUP_LABEL, type TimeGroupTier } from "./time-groups.js";
import type { Triage } from "./useTriage.js";

/** How many of a group's own rows stagger out individually before the rest
 * collapse with it (#66's "the first ~8 rows stagger out, then the group
 * collapses as one") — a fixed cap, not "however many happen to be loaded",
 * so a group of thousands doesn't animate thousands of rows. */
export const GROUP_STAGGER_ROW_CAP = 8;

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
 * spec.md §The result list) — and, per #75, exactly the shape with no taper
 * either: a header's tier is what drives the taper, and an ungrouped list
 * has no headers. `getRowExtra`/`footer` are the row/foot decorations that
 * section also asks for; every prop here defaults to exactly today's
 * behavior, so #40's own callers are unaffected.
 *
 * Every item's height comes from `taper.ts` (grouped) or `ungroupedRowHeight`
 * (search) — never a `mail.css` class — so the virtualizer's `estimateSize`
 * and the item's own rendered height are the same one number, not two that
 * could drift (#75's "per-tier row heights are known to the virtualizer, not
 * duplicated between code and CSS").
 */

type ListItem =
  | {
      kind: "header";
      key: string;
      label: string;
      tier: TimeGroupTier;
      loadedCount: number;
      /** This group's own collapsed state (#78) — read once per `items` pass, not re-read per render, so a header and the rows it hides (or doesn't) always agree within one frame. */
      collapsed: boolean;
    }
  | {
      kind: "thread";
      key: string;
      thread: CachedThread;
      index: number;
      tier: TimeGroupTier | null;
      /** This row's own group header label — `null` outside a grouped list. Matched against `previewGroupLabel` below, never the tier alone: two different groups can share a tier (#77). */
      groupLabel: string | null;
    };

/** The group header cluster (#66, #67, #77): the target-set math (which
 * Threads a group's "Done all"/"Mark all read" names) lives one layer up in
 * `MailSection`/`group-target.ts` — this component only ever hands back a
 * group's own `label`, never resolves a request itself. */
export interface GroupBulkController {
  /** The group's true total (`POST /bulk-triage/count`), once resolved — the header falls back to its own loaded count until then (#77: "the header shows the group's true total... not the loaded count"). */
  countFor: (label: string) => number | null;
  /** Kicks off the (memoized, at the caller) true-count fetch for a header the moment it's armed — hover, focus, or tap. Safe to call repeatedly. */
  requestCount: (label: string) => void;
  onDoneAll: (label: string) => void;
  onMarkAllRead: (label: string) => void;
  /** Thread ids mid-collapse after a Done all on their own group (#66's stagger) — rendered leaving rather than vanishing mid-frame. */
  clearingThreadIds: ReadonlySet<string>;
}

/** How close to the bottom (in rows) triggers widening the requested page. */
const LOAD_MORE_THRESHOLD = 10;

export interface RowExtra {
  headline?: string | null;
  folderPill?: string | null;
  actionBadge?: string | null;
  /** The Held/Blocked badge (#56, `docs/search-ux-spec.md` §The row) — search's own result decoration, same as the other three. */
  gatekeeperBadge?: "held" | "blocked" | null;
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
  density = DEFAULT_LIST_DENSITY,
  groupBulk,
}: {
  threads: readonly CachedThread[];
  /** False once the window has been truncated at the bottom (ADR-0009). */
  complete: boolean;
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  /** Requests a wider page — called once as the viewport nears the bottom. */
  onLoadMore?: () => void;
  /** Present wires each row's swipe-to-Done/-Snooze (#44, #76); omitted, rows render with no swipe affordance. */
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
  /** The `compact` List Density Device Preference (#54) — shifts every taper tier by a fixed delta (#75, `taper.ts`) rather than flattening it. */
  density?: ListDensity;
  /** The group header cluster's own Done all / Mark all read / true-count wiring (#66, #77) — omitted anywhere the current folder isn't a valid bulk-Triage target (`MailSection`'s own gating), same "every prop here defaults to exactly today's behavior" posture the rest of this component's props already have. */
  groupBulk?: GroupBulkController;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Collapsed state (#78) lives in `localStorage`, not React state — it's
  // read fresh into `items` below on every pass, and `toggleCollapsed`
  // forces that pass by bumping this counter. That keeps one source of
  // truth (the device preference itself) rather than a React copy that
  // could drift from it.
  const [collapsedVersion, setCollapsedVersion] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `collapsedVersion` is a deliberate re-read trigger, not a value this reads directly.
  const items = useMemo<ListItem[]>(() => {
    if (!group) {
      return threads.map((thread, index) => ({
        kind: "thread" as const,
        key: thread.id,
        thread,
        index,
        tier: null,
        groupLabel: null,
      }));
    }
    const groups = groupThreadsByTime(threads);
    const flat: ListItem[] = [];
    let index = 0;
    for (const groupItem of groups) {
      const collapsed = readGroupCollapsed(groupItem.label);
      flat.push({
        kind: "header",
        key: `header:${groupItem.label}:${index}`,
        label: groupItem.label,
        tier: groupItem.tier,
        loadedCount: groupItem.threads.length,
        collapsed,
      });
      if (collapsed) continue;
      for (const thread of groupItem.threads) {
        flat.push({
          kind: "thread",
          key: thread.id,
          thread,
          index,
          tier: groupItem.tier,
          groupLabel: groupItem.label,
        });
        index += 1;
      }
    }
    return flat;
  }, [threads, group, collapsedVersion]);

  const toggleCollapsed = useCallback((label: string) => {
    const next = !readGroupCollapsed(label);
    writeGroupCollapsed(label, next);
    setCollapsedVersion((version) => version + 1);
  }, []);

  // The header checkmark's spine preview (#66, #77): hovering/focusing it
  // arms every row in *that one* group, matched by label rather than tier —
  // two different date groups can share a tier, and the preview must never
  // leak across a boundary the User can plainly read.
  const [previewGroupLabel, setPreviewGroupLabel] = useState<string | null>(null);

  const itemHeight = useCallback(
    (item: ListItem | undefined): number => {
      if (!item) return ungroupedRowHeight(density);
      if (item.kind === "header") return taperHeaderHeight(item.tier, density);
      return item.tier === null ? ungroupedRowHeight(density) : taperRowHeight(item.tier, density);
    },
    [density],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => itemHeight(items[index]),
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

  // Each clearing Thread's position within its own group's clearing set,
  // capped at `GROUP_STAGGER_ROW_CAP` — the stagger's `--group-clear-index`
  // custom property below, computed once here rather than re-derived per
  // row. Threads past the cap still leave (the group collapse below covers
  // them), they just don't get their own staggered delay.
  const clearIndexById = useMemo(() => {
    const map = new Map<string, number>();
    const clearing = groupBulk?.clearingThreadIds;
    if (!clearing || clearing.size === 0) return map;
    let index = 0;
    let currentGroup: string | null | undefined;
    for (const item of items) {
      if (item.kind !== "thread" || !clearing.has(item.thread.id)) continue;
      if (item.groupLabel !== currentGroup) {
        currentGroup = item.groupLabel;
        index = 0;
      }
      map.set(item.thread.id, Math.min(index, GROUP_STAGGER_ROW_CAP - 1));
      index += 1;
    }
    return map;
  }, [items, groupBulk?.clearingThreadIds]);

  if (threads.length === 0) {
    return <p className="mail-empty">No mail cached for this account yet.</p>;
  }

  return (
    <div
      className={`thread-list${density === "compact" ? " thread-list--compact" : ""}`}
      ref={parentRef}
      role="listbox"
      aria-label="Threads"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualItems.map((virtualItem) => {
          const item = items[virtualItem.index];
          if (!item) return null;
          const extra = item.kind === "thread" ? getRowExtra?.(item.thread) : undefined;
          const clearIndex =
            item.kind === "thread" ? clearIndexById.get(item.thread.id) : undefined;
          return (
            <div
              key={item.key}
              data-index={virtualItem.index}
              data-clearing={clearIndex !== undefined || undefined}
              ref={virtualizer.measureElement}
              style={
                {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                  ...(clearIndex !== undefined ? { "--group-clear-index": clearIndex } : {}),
                } as CSSProperties
              }
            >
              {item.kind === "header" ? (
                // The header's own height is the taper's — `itemHeight` above
                // and this inline style are the same number, never a second
                // one guessed in `mail.css` (#75).
                <div
                  className="group-header"
                  data-tier={item.tier}
                  style={{ height: itemHeight(item) }}
                >
                  <GroupHeaderCluster
                    label={item.label}
                    loadedCount={item.loadedCount}
                    trueCount={groupBulk?.countFor(item.label) ?? null}
                    collapsed={item.collapsed}
                    onToggleCollapsed={() => toggleCollapsed(item.label)}
                    bulk={
                      groupBulk && item.label !== PINNED_GROUP_LABEL && item.label !== "Undated"
                        ? {
                            onArm: () => groupBulk.requestCount(item.label),
                            onDoneAll: () => groupBulk.onDoneAll(item.label),
                            onMarkAllRead: () => groupBulk.onMarkAllRead(item.label),
                            onPreview: (active) => setPreviewGroupLabel(active ? item.label : null),
                          }
                        : undefined
                    }
                  />
                </div>
              ) : (
                <ThreadRow
                  thread={item.thread}
                  selected={item.thread.id === selectedThreadId}
                  onSelect={() => onSelect(item.thread.id)}
                  onArchive={triage ? () => triage.archive(item.thread.id) : undefined}
                  onSnooze={triage ? (until) => triage.snooze(item.thread.id, until) : undefined}
                  headline={extra?.headline}
                  folderPill={extra?.folderPill}
                  actionBadge={extra?.actionBadge}
                  gatekeeperBadge={extra?.gatekeeperBadge}
                  tier={item.tier}
                  height={itemHeight(item)}
                  previewArmed={previewGroupLabel !== null && item.groupLabel === previewGroupLabel}
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

/** The group header cluster's own bulk-Triage wiring (#66, #77) — omitted for a group that isn't a valid bulk-Triage target (Pinned, Undated) or when `groupBulk` itself isn't wired in for the current folder; Collapse (#78) is unaffected either way. */
interface GroupHeaderClusterBulk {
  onArm: () => void;
  onDoneAll: () => void;
  onMarkAllRead: () => void;
  onPreview: (active: boolean) => void;
}

/**
 * The group header's own row cluster (#66, #77, #78): resting the pointer
 * on a header — or tapping it, on touch — arms **Collapse**, and where
 * `bulk` is present, **Done all** and **Mark all read** too, the header's
 * own mirror of `ThreadRow`'s row-level Done control (#75). Every button
 * stays in the DOM (and the tab order) regardless of armed state —
 * `mail.css`'s `[data-armed]` rule only ever changes their opacity, the
 * same "real component state, not a CSS-only trick" `ThreadRow`'s own doc
 * comment insists on, and `:focus-visible` reveals any one of them directly
 * so Tab can always reach it.
 *
 * The checkmark is *also* the Done all trigger — hovering or focusing it
 * additionally previews the group: `onPreview` bubbles to
 * `VirtualizedThreadList`, which force-arms every row in this one group's
 * own Done control (`ThreadRow`'s `previewArmed`) so the User sees exactly
 * what committing would do before they click.
 */
function GroupHeaderCluster({
  label,
  loadedCount,
  trueCount,
  collapsed,
  onToggleCollapsed,
  bulk,
}: {
  label: string;
  loadedCount: number;
  trueCount: number | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  bulk?: GroupHeaderClusterBulk;
}) {
  const [armed, setArmed] = useState(false);
  const count = trueCount ?? loadedCount;

  const arm = useCallback(() => {
    setArmed(true);
    bulk?.onArm();
  }, [bulk]);
  const disarm = useCallback(() => setArmed(false), []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus arm the cluster (#66); every actual control below is a real, independently focusable <button>.
    // biome-ignore lint/a11y/useKeyWithClickEvents: `onClick` here is touch's stand-in for hover, not an action — a keyboard User already arms the cluster by Tabbing to any button below (`onFocus`), and each is an ordinary, independently keyboard-operable `<button>`.
    <div
      className="group-header-cluster"
      data-armed={armed}
      onMouseEnter={arm}
      onMouseLeave={disarm}
      onFocus={arm}
      onBlur={(event) => {
        // A focus move that stays inside the cluster (checkmark → Mark all
        // read, say) must not disarm it mid-Tab.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) disarm();
      }}
      onClick={() => {
        // Touch has no hover: tapping the header arms it the same way
        // resting the pointer does at desktop (#66's own acceptance bar).
        setArmed((current) => !current);
      }}
    >
      {bulk ? (
        <button
          type="button"
          className="group-done"
          aria-label={`Done with ${label}`}
          title="Done all"
          onMouseEnter={() => bulk.onPreview(true)}
          onMouseLeave={() => bulk.onPreview(false)}
          onFocus={() => bulk.onPreview(true)}
          onBlur={() => bulk.onPreview(false)}
          onClick={(event) => {
            event.stopPropagation();
            bulk.onDoneAll();
          }}
        >
          <Pictogram name="check" size={12} />
        </button>
      ) : null}
      <span className="group-header-label">{label}</span>
      <span className="group-header-count">{count}</span>
      <button
        type="button"
        className="group-collapse"
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
        aria-expanded={!collapsed}
        title={collapsed ? "Expand" : "Collapse"}
        onClick={(event) => {
          event.stopPropagation();
          onToggleCollapsed();
        }}
      >
        <Pictogram name={collapsed ? "expand" : "collapse"} size={12} />
      </button>
      {bulk ? (
        <button
          type="button"
          className="group-mark-read"
          aria-label={`Mark ${label} read`}
          title="Mark all read"
          onClick={(event) => {
            event.stopPropagation();
            bulk.onMarkAllRead();
          }}
        >
          <Pictogram name="opened" size={12} />
        </button>
      ) : null}
    </div>
  );
}
