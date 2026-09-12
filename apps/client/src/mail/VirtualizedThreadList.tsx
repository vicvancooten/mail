import type { AutoAdvanceDirection } from "@mail/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronDown, ChevronUp, MailOpen, MoreHorizontal } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.js";
import { useHoverCapable } from "../hooks/use-hover-capable.js";
import { type CachedThread, useFirstDayOfWeek, useRegionFormatSettings } from "../store/index.js";
import { ActionMenu } from "./actions/ActionMenu.js";
import { useActions } from "./actions/ActionsProvider.js";
import { actionById, surfaceActions } from "./actions/registry.js";
import { publishListHandle } from "./actions/surface-handles.js";
import { type ActionContext, actionLabel, withGroup, withThread } from "./actions/types.js";
import {
  DEFAULT_LIST_DENSITY,
  type ListDensity,
  readGroupCollapsed,
  useGroupCollapsedVersion,
  writeGroupCollapsed,
} from "./device-preferences.js";
import { readListScrollOffset, saveListScrollOffset } from "./scroll-restore.js";
import { type RowHoverAction, ThreadRow } from "./ThreadRow.js";
import { taperHeaderHeight, taperRowHeight, ungroupedRowHeight } from "./taper.js";
import { groupThreadsByTime, PINNED_GROUP_LABEL, type TimeGroupTier } from "./time-groups.js";
import type { Triage } from "./useTriage.js";

/** How many of a group's own rows stagger out individually before the rest
 * collapse with it (#66's "the first ~8 rows stagger out, then the group
 * collapses as one") — a fixed cap, not "however many happen to be loaded",
 * so a group of thousands doesn't animate thousands of rows. */
export const GROUP_STAGGER_ROW_CAP = 8;

/** #295: manual Collapse's own stagger step and transition duration — the
 * same numbers the Done-all bulk clear (`MailSection.tsx`'s own
 * `GROUP_STAGGER_STEP_MS`/`GROUP_COLLAPSE_DURATION_MS`) already uses, kept
 * as their own constants here rather than imported, since this component
 * has no dependency on `MailSection` and the two are free to drift apart
 * later if the two motions ever need to. */
const MANUAL_COLLAPSE_STAGGER_STEP_MS = 45;
const MANUAL_COLLAPSE_TRANSITION_MS = 260;

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
  /** The Mail Account a cross-account search result came from (#80) — the account's own address, shown only where a search spans more than one in-scope account (`SearchResultsView`'s own `showAccountBadge`). */
  accountBadge?: string | null;
}

export function VirtualizedThreadList({
  threads,
  complete,
  selectedThreadId,
  onSelect,
  onOpenSheet,
  onLoadMore,
  triage,
  group = true,
  footer,
  getRowExtra,
  keyboardDisabled = false,
  initialScrollThreadId = null,
  scrollRestoreKey = null,
  density = DEFAULT_LIST_DENSITY,
  groupBulk,
}: {
  threads: readonly CachedThread[];
  /** False once the window has been truncated at the bottom (ADR-0009). */
  complete: boolean;
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  /** Double-clicking a row opens the Reader Sheet over the list (#292) — omitted, rows double-click to no extra effect beyond the single click each half of the gesture already fires (`ThreadRow`'s own `event.detail` guard). */
  onOpenSheet?: (id: string) => void;
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
  /** Keeps this list from publishing its selection mover (#94) — for a copy of the list left mounted-but-hidden behind another surface (#51's search route swap), which must not be what `j`/`k` moves through. */
  keyboardDisabled?: boolean;
  /** Scrolls this Thread into view once, on mount — #51's "leaving [search] restores... its scroll position" (search-ux-spec.md), approximated as "the Thread you had open is back in view" rather than a raw pixel offset. Also `scrollRestoreKey`'s own fallback (#142): tried only when that key is unset or has no saved offset yet, or the saved one no longer fits this list. */
  initialScrollThreadId?: string | null;
  /** This list's own identity for `scroll-restore.ts` (#142) — Account Scope + folder + label, from `MailSection`. Unset (search's own ungrouped list, `group={false}`) opts out of both saving and restoring a pixel offset entirely, leaving `initialScrollThreadId` as the only behavior, same as before this ticket. */
  scrollRestoreKey?: string | null;
  /** The `compact` List Density Device Preference (#54) — shifts every taper tier by a fixed delta (#75, `taper.ts`) rather than flattening it. */
  density?: ListDensity;
  /** The group header cluster's own Done all / Mark all read / true-count wiring (#66, #77) — omitted anywhere the current folder isn't a valid bulk-Triage target (`MailSection`'s own gating), same "every prop here defaults to exactly today's behavior" posture the rest of this component's props already have. */
  groupBulk?: GroupBulkController;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  // #142: a plain `ref` alone can't drive an effect's dependency array, and
  // this list's empty state (`threads.length === 0`, below) renders a `<p>`
  // with no scroll container at all — the first real commit of the
  // container can land on a *later* render than this component's own first
  // one (the Local Cache's read resolves asynchronously), after which a
  // `useEffect(fn, [])` has already fired, once, against a `parentRef` that
  // was still null. Mirroring the container node into state via this
  // callback ref gives the restore/tracking effects below a value that
  // actually changes on the render where the node first exists, so `[
  // scrollContainer]` fires them at the right time regardless of which
  // render that turns out to be.
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const setParentRef = useCallback((node: HTMLDivElement | null) => {
    parentRef.current = node;
    setScrollContainer(node);
  }, []);

  // Gates every hover-only affordance below — the row Done glyph, the
  // Group Done node, bulk actions and the Timeline Spine — on input
  // capability rather than viewport width (#134): read once here and
  // threaded down, so a header and its rows never disagree about which set
  // is on screen.
  const hoverCapable = useHoverCapable();

  // Region Settings (#304): the same First Day of the Week/locale
  // `time-groups.ts#groupThreadsByTime` reads for "This week"/"Last week"
  // and the named-month labels below.
  const firstDayOfWeek = useFirstDayOfWeek();
  const region = useRegionFormatSettings();

  // Collapsed state (#78) lives in the Device Preference module
  // (`device-preferences.ts`), not React state — it's read fresh into
  // `items` below on every pass. `useGroupCollapsedVersion` (#272) is what
  // forces that pass: it re-renders this component the instant *any* label
  // is written, from this list's own toggle or another mounted subscriber,
  // the same "one write reaches every subscriber" shape the module's other
  // reactive pairs give a single value — a label list isn't known ahead of
  // a render, so a hook per label doesn't fit here the way it does there.
  const collapsedVersion = useGroupCollapsedVersion();

  // Manual Collapse's own leave/enter transition (#295): a header click must
  // animate, not snap — instant unmount the moment `writeGroupCollapsed`
  // flips a label true would be exactly that snap. `leavingGroupLabels`
  // keeps a *collapsing* group's rows in `items` below (past the render
  // where the persisted flag has already gone true, so the header's own
  // Collapse/Expand control and `aria-expanded` flip the instant it's
  // clicked) for one more transition's worth of time, tagged `data-
  // clearing` the same way the Done-all bulk clear already stages a row's
  // exit; `enteringGroupLabels` is Expand's mirror — the persisted flag is
  // already false and the rows are already back in `items`, so this only
  // adds the `data-entering` stagger-in tag for one transition's worth of
  // time. Never both for the same label at once (`toggleCollapsed` clears
  // whichever set doesn't apply before adding to the other).
  const [leavingGroupLabels, setLeavingGroupLabels] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [enteringGroupLabels, setEnteringGroupLabels] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const collapseTransitionTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = collapseTransitionTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

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
    const groups = groupThreadsByTime(threads, new Date(), firstDayOfWeek, region);
    const flat: ListItem[] = [];
    let index = 0;
    for (const groupItem of groups) {
      const collapsed = readGroupCollapsed(groupItem.label);
      flat.push({
        kind: "header",
        // Keyed by label alone (#279) — a running row index means a Group
        // Done removing rows above this header remounts it, losing its
        // hover/focus/collapse animation state. `groupThreadsByTime` never
        // re-sorts and only ever merges *contiguous* same-label runs, so one
        // label can't recur non-adjacently within a render's groups.
        key: `header:${groupItem.label}`,
        label: groupItem.label,
        tier: groupItem.tier,
        loadedCount: groupItem.threads.length,
        collapsed,
      });
      // A group mid-collapse (`leavingGroupLabels`) still renders its rows,
      // one transition's worth past the persisted flag going true — #295's
      // "collapse animates rather than snaps".
      if (collapsed && !leavingGroupLabels.has(groupItem.label)) continue;
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
  }, [threads, group, collapsedVersion, leavingGroupLabels, firstDayOfWeek, region]);

  const toggleCollapsed = useCallback((label: string) => {
    const wasCollapsed = readGroupCollapsed(label);
    const pendingTimer = collapseTransitionTimers.current.get(label);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      collapseTransitionTimers.current.delete(label);
    }
    // Either direction flips the persisted flag *immediately* — the header's
    // own control and `aria-expanded` must never lag the click, only the
    // rows do — then stages that direction's own animation tag for one
    // transition's worth of time.
    writeGroupCollapsed(label, !wasCollapsed);
    if (wasCollapsed) {
      setLeavingGroupLabels((current) => {
        if (!current.has(label)) return current;
        const next = new Set(current);
        next.delete(label);
        return next;
      });
      setEnteringGroupLabels((current) => new Set(current).add(label));
    } else {
      setEnteringGroupLabels((current) => {
        if (!current.has(label)) return current;
        const next = new Set(current);
        next.delete(label);
        return next;
      });
      setLeavingGroupLabels((current) => new Set(current).add(label));
    }
    collapseTransitionTimers.current.set(
      label,
      setTimeout(
        () => {
          if (wasCollapsed) {
            setEnteringGroupLabels((current) => {
              const next = new Set(current);
              next.delete(label);
              return next;
            });
          } else {
            setLeavingGroupLabels((current) => {
              const next = new Set(current);
              next.delete(label);
              return next;
            });
          }
          collapseTransitionTimers.current.delete(label);
        },
        MANUAL_COLLAPSE_STAGGER_STEP_MS * GROUP_STAGGER_ROW_CAP + MANUAL_COLLAPSE_TRANSITION_MS,
      ),
    );
  }, []);

  // The header checkmark's spine preview (#66, #77): hovering/focusing it
  // arms every row in *that one* group, matched by label rather than tier —
  // two different date groups can share a tier, and the preview must never
  // leak across a boundary the User can plainly read.
  const [previewGroupLabel, setPreviewGroupLabel] = useState<string | null>(null);

  // The last known pointer position over this list, in viewport
  // coordinates — kept in a ref, not state, since it changes on every
  // `mousemove` and none of those by themselves should force a render (#152).
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  // The Thread now sitting under that stationary pointer, force-armed the
  // same way `previewArmed` forces a group's rows above — but recomputed
  // off `items` changing (a Triage action removing a row), never off a real
  // `mousemove`: a row sliding up under a pointer that never moved fires no
  // `mouseenter` of its own, so without this it would sit unarmed until the
  // User actually moves the mouse, and a same-spot click would open the
  // mail that just arrived there instead of repeating Done (#152's "Hover
  // re-arm"). A real `mousemove` clears it below — the row genuinely under
  // the pointer by then has already fired its own `mouseenter`/`mouseleave`,
  // so its own hover state is the one to trust from that point on.
  const [pointerArmedThreadId, setPointerArmedThreadId] = useState<string | null>(null);

  const trackPointer = useCallback((event: { clientX: number; clientY: number }) => {
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    setPointerArmedThreadId(null);
  }, []);

  const clearPointer = useCallback(() => {
    lastPointerRef.current = null;
    setPointerArmedThreadId(null);
  }, []);

  // Every control this list draws that isn't structure comes from the
  // Action registry (#94): the row's Done check, its hover cluster, its
  // right-click menu, and the Time Group header's own menu. Without a
  // provider above it (a unit test rendering this list on its own) the
  // rows fall back to the `triage` prop, unchanged.
  const actions = useActions();

  /** This row's hover cluster: every `"row-hover"` action the registry has available for it, minus Done — which has reserved whitespace of its own on the left rather than a place in the cluster. */
  const rowHoverActions = useCallback(
    (rowCtx: ActionContext, thread: CachedThread): RowHoverAction[] =>
      surfaceActions(rowCtx, "row-hover")
        .filter((action) => action.id !== "done")
        .map((action) => {
          const subject = thread.subject || "(no subject)";
          const label = `${actionLabel(action, rowCtx)} "${subject}"`;
          const keycap = action.binding ? ` (${action.binding.display.toLowerCase()})` : "";
          return {
            id: action.id,
            label,
            title: `${actionLabel(action, rowCtx)}${keycap}`,
            icon: action.icon,
            on: action.id === "pin" ? thread.pinned : undefined,
            picker: action.id === "snooze" ? ("snooze" as const) : undefined,
            run: () => action.run(rowCtx),
            onPick:
              action.id === "snooze"
                ? (until: string) => rowCtx.triage.snooze(thread.id, until)
                : undefined,
          };
        }),
    [],
  );

  const itemHeight = useCallback(
    (item: ListItem | undefined): number => {
      if (!item) return ungroupedRowHeight(density);
      if (item.kind === "header") return taperHeaderHeight(item.tier, density);
      return item.tier === null ? ungroupedRowHeight(density) : taperRowHeight(item.tier, density);
    },
    [density],
  );

  // Each item's own top offset, as a plain prefix sum over `itemHeight` — the
  // same one number the virtualizer's `estimateSize` and each item's own
  // rendered `style.height` both already use (#75's "not duplicated between
  // code and CSS"), read here directly rather than through the virtualizer's
  // own (ResizeObserver-corrected, in a real browser) measurement of the
  // mounted DOM: #152's pointer math cares about intended layout, which this
  // gives exactly, with no dependency on however a `<div>` happens to measure
  // under whatever's currently rendering it (jsdom included).
  const itemOffsets = useMemo(() => {
    const offsets: number[] = [];
    let offset = 0;
    for (const item of items) {
      offsets.push(offset);
      offset += itemHeight(item);
    }
    return offsets;
  }, [items, itemHeight]);

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

  // #152: re-checked on every `items` change (a row removed by Done, most
  // often) rather than on a `mousemove` — the whole bug is that the pointer
  // never moves. Reads the container's current geometry fresh (`parentRef`
  // isn't itself a dependency — a ref never changes identity) rather than
  // closing over it, so it always judges the list exactly as it just
  // rendered.
  useEffect(() => {
    const pointer = lastPointerRef.current;
    const container = parentRef.current;
    if (!pointer || !container) return;
    const rect = container.getBoundingClientRect();
    if (
      pointer.x < rect.left ||
      pointer.x > rect.right ||
      pointer.y < rect.top ||
      pointer.y > rect.bottom
    ) {
      return;
    }
    const relativeY = pointer.y - rect.top + container.scrollTop;
    const hitIndex = itemOffsets.findIndex(
      (start, index) => relativeY >= start && relativeY < start + itemHeight(items[index]),
    );
    const item = hitIndex !== -1 ? items[hitIndex] : undefined;
    setPointerArmedThreadId(item?.kind === "thread" ? item.thread.id : null);
  }, [items, itemOffsets, itemHeight]);

  // Runs once the scroll container actually exists, whichever render that
  // is (`scrollContainer`'s own doc comment) — a `restoredRef` guard, not an
  // empty dependency array, is what makes this "once per real mount" now,
  // since `scrollRestoreKey`/`initialScrollThreadId` reasonably belong in
  // the dependency array but must never re-trigger a second scroll partway
  // through the same mount (a folder switch, say).
  const restoredRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `restoredRef` guards this to exactly once per mount; re-running it for every later change to `scrollRestoreKey`/`initialScrollThreadId`/`items` would re-scroll the list out from under whoever is looking at it.
  useEffect(() => {
    if (!scrollContainer || restoredRef.current) return;
    restoredRef.current = true;
    // #142: a saved pixel offset wins over the Thread-into-view fallback
    // whenever one exists *and* still fits this list — `<=` its current
    // total size, so a saved offset the removal of Threads (Done,
    // Auto-advance) has pushed past the end falls through to the fallback
    // instead of leaving the list scrolled to a blank gap.
    const savedOffset = scrollRestoreKey ? readListScrollOffset(scrollRestoreKey) : null;
    if (savedOffset !== null && savedOffset <= virtualizer.getTotalSize()) {
      virtualizer.scrollToOffset(savedOffset, { align: "start" });
      return;
    }
    if (!initialScrollThreadId) return;
    const itemIndex = items.findIndex(
      (item) => item.kind === "thread" && item.thread.id === initialScrollThreadId,
    );
    if (itemIndex !== -1) virtualizer.scrollToIndex(itemIndex, { align: "auto" });
  }, [scrollContainer]);

  // The offset this list is scrolled to right now, tracked continuously
  // rather than read from `scrollContainer` at unmount — a host ref/state
  // value can already be cleared by the time a passive effect's cleanup
  // runs, but a plain ref this component itself owns can't be.
  const currentOffsetRef = useRef(0);
  useEffect(() => {
    if (!scrollContainer) return;
    const handleScroll = () => {
      currentOffsetRef.current = scrollContainer.scrollTop;
    };
    handleScroll();
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollContainer.removeEventListener("scroll", handleScroll);
  }, [scrollContainer]);

  // Saves this list's own last-known offset under its key the moment it
  // leaves — unmounting (the List layout's Reader taking its place) or
  // `scrollRestoreKey` itself changing out from under it (a folder/label
  // switch while mounted, e.g. in Split) both count as "left" (#142).
  useEffect(() => {
    return () => {
      if (scrollRestoreKey) saveListScrollOffset(scrollRestoreKey, currentOffsetRef.current);
    };
  }, [scrollRestoreKey]);

  const threadIds = useMemo(
    () => items.filter((item) => item.kind === "thread").map((item) => item.thread.id),
    [items],
  );

  // #275: the roving tab stop — exactly one row's own `tabIndex` is `0` at
  // any time, the rest `-1` (a real listbox, Tab leaves it rather than
  // walking every row). The selected row is that stop; with nothing selected
  // yet (a fresh mount, no URL Thread), it defaults to the first row, so
  // Tab always has exactly one place to land even before any `j`/`k`/click.
  const rovingThreadId =
    selectedThreadId && threadIds.includes(selectedThreadId)
      ? selectedThreadId
      : (threadIds[0] ?? null);

  // The `threads.length === 0` branch below renders its own listbox wrapper
  // — a *plain* ref, deliberately never `setParentRef`: that one also feeds
  // `scrollContainer` state, which the scroll-restore effects above treat as
  // "a real mount to restore into" (`restoredRef`'s own once-only guard).
  // Threads reads `[]` for a beat on every remount, before the Local Cache's
  // reactive read resolves — routing that transient div through
  // `setParentRef` fed the restore effect a container with nothing in it
  // (`virtualizer.getTotalSize()` reads `0`), which found no saved offset
  // small enough to fit, consumed the guard anyway, and then never got to
  // run again once the real list actually mounted a beat later. This ref
  // exists purely so Auto-advance's own "the listbox holds focus once the
  // list is *genuinely* empty" (#275) still has a node to focus, without
  // that transient render ever touching scroll-restore's own state.
  const emptyContainerRef = useRef<HTMLDivElement | null>(null);

  // Moves real DOM focus onto `threadId`'s row — or the listbox container
  // itself, `null`/not-yet-rendered's fallback (#275's "when the list
  // becomes empty [focus lands on] the listbox"). Queried by
  // `data-thread-id` rather than kept in a ref map: `ThreadRow` renders
  // several DOM layers deep (the swipe wrapper), so this is the one stable
  // handle to its actual `role="option"` element from up here.
  // `undefined` (as opposed to `null`, "focus the listbox itself") means "no
  // pending request" — what lets `attemptPendingFocus` below no-op cheaply
  // on every render once a request is fulfilled.
  const pendingFocusRef = useRef<string | null | undefined>(undefined);
  const attemptPendingFocus = useCallback(() => {
    if (pendingFocusRef.current === undefined) return;
    // Exactly one of these is ever mounted at a time (the two return
    // branches below), so exactly one is non-null for the current render.
    const container = parentRef.current ?? emptyContainerRef.current;
    if (!container) return;
    const id = pendingFocusRef.current;
    if (id) {
      const node = container.querySelector<HTMLElement>(
        `[data-thread-id="${id.replace(/"/g, '\\"')}"]`,
      );
      if (!node) return; // not mounted yet (still scrolling into view) — retried on the next render
      node.focus();
    } else {
      container.focus();
    }
    pendingFocusRef.current = undefined;
  }, []);
  const focusThread = useCallback(
    (threadId: string | null) => {
      pendingFocusRef.current = threadId;
      attemptPendingFocus();
    },
    [attemptPendingFocus],
  );
  // Retries a focus request that landed before its row was actually
  // mounted (out of the virtualized window, still scrolling into place) —
  // runs after every render, which is cheap once `pendingFocusRef` is back
  // to `undefined` (the overwhelmingly common case: the target row is
  // already mounted, per this list's own overscan).
  useEffect(() => {
    attemptPendingFocus();
  });

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
        focusThread(nextId);
      }
    },
    [threadIds, selectedThreadId, onSelect, items, virtualizer, focusThread],
  );

  // Auto-advance's own collapse-aware neighbor lookup (#275,
  // `useTriage#advanceSelection`): the exact `older`-preferred/`newer`-
  // preferred-with-edge-fallback math that hook used to run over a flat id
  // array, now over this list's own `threadIds` — so a collapsed Time
  // Group (#78) is skipped by Auto-advance exactly as it already is by
  // `moveSelection` above, both reading the one ordered list.
  const neighborOf = useCallback(
    (threadId: string, direction: AutoAdvanceDirection): string | null => {
      const idx = threadIds.indexOf(threadId);
      if (idx === -1) return null;
      const older = threadIds[idx + 1] ?? null;
      const newer = idx > 0 ? (threadIds[idx - 1] ?? null) : null;
      return direction === "newer" ? (newer ?? older) : (older ?? newer);
    },
    [threadIds],
  );

  // This list's own mover, published for the Action registry's single
  // `keydown` listener to call (#94). It used to be reached by a second
  // `keydown` listener right here, which fought `useTriage`'s for `j`/`k`
  // — both fired, and only this one knew to skip a collapsed group's rows
  // (#78) and to scroll the arrived-at row into view. Now the registry's
  // `next-thread`/`prev-thread` entries call it, and nothing else binds
  // those keys. `neighborOf`/`focusThread` (#275) are the same handle's
  // other two faces: `useTriage`'s Auto-advance calls the former to pick
  // where to land and the latter to actually put DOM focus there.
  useEffect(() => {
    if (keyboardDisabled) return;
    return publishListHandle({ move: moveSelection, neighborOf, focusThread });
  }, [moveSelection, neighborOf, focusThread, keyboardDisabled]);

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

  // #295's own manual-Collapse leave/enter stagger — same per-group index
  // math as `clearIndexById` above, keyed off `leavingGroupLabels`/
  // `enteringGroupLabels` (a whole group's own rows) rather than a bulk
  // action's individual Thread ids.
  const collapseLeaveIndexById = useMemo(() => {
    const map = new Map<string, number>();
    if (leavingGroupLabels.size === 0) return map;
    let index = 0;
    let currentGroup: string | null | undefined;
    for (const item of items) {
      if (item.kind !== "thread" || !item.groupLabel || !leavingGroupLabels.has(item.groupLabel)) {
        continue;
      }
      if (item.groupLabel !== currentGroup) {
        currentGroup = item.groupLabel;
        index = 0;
      }
      map.set(item.thread.id, Math.min(index, GROUP_STAGGER_ROW_CAP - 1));
      index += 1;
    }
    return map;
  }, [items, leavingGroupLabels]);

  const collapseEnterIndexById = useMemo(() => {
    const map = new Map<string, number>();
    if (enteringGroupLabels.size === 0) return map;
    let index = 0;
    let currentGroup: string | null | undefined;
    for (const item of items) {
      if (item.kind !== "thread" || !item.groupLabel || !enteringGroupLabels.has(item.groupLabel)) {
        continue;
      }
      if (item.groupLabel !== currentGroup) {
        currentGroup = item.groupLabel;
        index = 0;
      }
      map.set(item.thread.id, Math.min(index, GROUP_STAGGER_ROW_CAP - 1));
      index += 1;
    }
    return map;
  }, [items, enteringGroupLabels]);

  const doneAction = actionById("done");

  // The listbox stays the fallback focus target even with nothing in it
  // (#275: "when the list becomes empty [focus lands on] the listbox") —
  // Triage emptying the last Thread must not leave `document.activeElement`
  // stranded on a node this render just unmounted. `tabIndex={0}` only while
  // there's no row to hold that one roving stop itself (`threadIds.length
  // === 0` below covers both "nothing cached at all" and "every group is
  // collapsed").
  // The listbox stays the fallback focus target even with nothing in it
  // (#275: "when the list becomes empty [focus lands on] the listbox") —
  // Triage emptying the last Thread must not leave `document.activeElement`
  // stranded on a node this render just unmounted. `ref={emptyContainerRef}`
  // here, never `setParentRef` — see that ref's own doc comment above.
  if (threads.length === 0) {
    return (
      <div
        className={`thread-list${density === "compact" ? " thread-list--compact" : ""}`}
        ref={emptyContainerRef}
        role="listbox"
        aria-label="Threads"
        tabIndex={0}
      >
        <p className="mail-empty">No mail cached for this account yet.</p>
      </div>
    );
  }

  return (
    <div
      className={`thread-list${density === "compact" ? " thread-list--compact" : ""}`}
      ref={setParentRef}
      role="listbox"
      aria-label="Threads"
      tabIndex={threadIds.length === 0 ? 0 : -1}
      onMouseMove={trackPointer}
      onMouseLeave={clearPointer}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualItems.map((virtualItem) => {
          const item = items[virtualItem.index];
          if (!item) return null;
          const extra = item.kind === "thread" ? getRowExtra?.(item.thread) : undefined;
          // The registry, narrowed to this row's own Thread — what its Done
          // check, its hover cluster and its right-click menu all read, so
          // right-clicking a row nobody has opened acts on *that* row.
          const rowCtx =
            actions && item.kind === "thread" ? withThread(actions, item.thread) : null;
          const bulkClearIndex =
            item.kind === "thread" ? clearIndexById.get(item.thread.id) : undefined;
          const collapseLeaveIndex =
            item.kind === "thread" ? collapseLeaveIndexById.get(item.thread.id) : undefined;
          const collapseEnterIndex =
            item.kind === "thread" ? collapseEnterIndexById.get(item.thread.id) : undefined;
          // A bulk Done-all clear and a manual Collapse leave never target
          // the same row at once (the former runs on rows that are about to
          // stop existing; the latter on rows a header click is merely
          // folding away), so one combined "leaving" index covers both.
          const leavingIndex = bulkClearIndex ?? collapseLeaveIndex;
          return (
            <div
              key={item.key}
              data-index={virtualItem.index}
              data-clearing={leavingIndex !== undefined || undefined}
              data-entering={collapseEnterIndex !== undefined || undefined}
              // Mid-leave (or mid-enter), this element's own box never
              // changes size — only its opacity/transform animate — but
              // it's still handed to `measureElement` in every other frame,
              // which means a fresh `ResizeObserver` subscription churns for
              // a row about to vanish (or that just arrived) anyway (#97's
              // bug 3: "still fed to measureElement while transforming").
              // Skipping the ref while animating costs nothing: `items`
              // above stops rendering a leaving row outright once its
              // animation ends, and the virtualizer recomputes from scratch
              // on that pass regardless.
              ref={
                leavingIndex === undefined && collapseEnterIndex === undefined
                  ? virtualizer.measureElement
                  : undefined
              }
              style={
                {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                  ...(leavingIndex !== undefined
                    ? { "--group-clear-index": leavingIndex }
                    : collapseEnterIndex !== undefined
                      ? { "--group-clear-index": collapseEnterIndex }
                      : {}),
                } as CSSProperties
              }
            >
              {item.kind === "header" ? (
                // The header's own height is the taper's — `itemHeight` above
                // and this inline style are the same number, never a second
                // one guessed in `mail.css` (#75).
                <ActionMenu
                  ctx={
                    actions
                      ? withGroup(actions, {
                          label: item.label,
                          collapsed: item.collapsed,
                          onToggleCollapsed: () => toggleCollapsed(item.label),
                          onDoneAll: () => groupBulk?.onDoneAll(item.label),
                          onMarkAllRead: () => groupBulk?.onMarkAllRead(item.label),
                          bulkAvailable: Boolean(
                            groupBulk &&
                              item.label !== PINNED_GROUP_LABEL &&
                              item.label !== "Undated",
                          ),
                        })
                      : null
                  }
                  asChild
                  label={`Actions for ${item.label}`}
                >
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
                      hoverCapable={hoverCapable}
                      bulk={
                        groupBulk && item.label !== PINNED_GROUP_LABEL && item.label !== "Undated"
                          ? {
                              onArm: () => groupBulk.requestCount(item.label),
                              onDoneAll: () => groupBulk.onDoneAll(item.label),
                              onMarkAllRead: () => groupBulk.onMarkAllRead(item.label),
                              onPreview: (active) =>
                                setPreviewGroupLabel(active ? item.label : null),
                            }
                          : undefined
                      }
                    />
                  </div>
                </ActionMenu>
              ) : (
                <ThreadRow
                  thread={item.thread}
                  selected={item.thread.id === selectedThreadId}
                  onSelect={() => onSelect(item.thread.id)}
                  onOpenSheet={onOpenSheet ? () => onOpenSheet(item.thread.id) : undefined}
                  onArchive={
                    rowCtx && doneAction?.availability(rowCtx).available
                      ? () => doneAction.run(rowCtx)
                      : triage
                        ? () => triage.archive(item.thread.id)
                        : undefined
                  }
                  onTrash={triage ? () => triage.trash(item.thread.id) : undefined}
                  onSnooze={triage ? (until) => triage.snooze(item.thread.id, until) : undefined}
                  onTogglePin={triage ? () => triage.togglePin(item.thread.id) : undefined}
                  hoverActions={rowCtx ? rowHoverActions(rowCtx, item.thread) : undefined}
                  hoverCapable={hoverCapable}
                  contextMenu={
                    rowCtx
                      ? (row) => (
                          <ActionMenu
                            ctx={rowCtx}
                            asChild
                            label={`Actions for "${item.thread.subject || "(no subject)"}"`}
                          >
                            {row}
                          </ActionMenu>
                        )
                      : undefined
                  }
                  headline={extra?.headline}
                  folderPill={extra?.folderPill}
                  actionBadge={extra?.actionBadge}
                  gatekeeperBadge={extra?.gatekeeperBadge}
                  accountBadge={extra?.accountBadge}
                  tier={item.tier}
                  height={itemHeight(item)}
                  previewArmed={previewGroupLabel !== null && item.groupLabel === previewGroupLabel}
                  pointerArmed={item.thread.id === pointerArmedThreadId}
                  tabbable={item.thread.id === rovingThreadId}
                  region={region}
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
 * The group header's own cluster (#66, #77, #78, rebuilt in #87 against the
 * comp's `.group-header` and fixed in #97 against it): the group's own
 * **rail** on the left — the same 26px gutter the rows below reserve, so
 * the header's Done-all node sits exactly above every row's own Done
 * control — then the label, the count in the machine face, and, pushed to
 * the trailing edge, the actions that only appear once the header is armed.
 *
 * Resting the pointer on the header, or focusing anything inside it, arms
 * **Collapse**, and where `bulk` is present, **Done all** and **Mark all
 * read** too. Every button stays in the DOM (and the tab order) regardless
 * of armed state: `mail.css`'s `[data-armed]` rule only ever changes their
 * opacity and scale, the same "real component state, not a CSS-only trick"
 * `ThreadRow`'s own doc comment insists on, and `:focus-visible` reveals any
 * one of them directly so Tab can always reach it. Clicking the header's own
 * background (never one of these buttons — each stops its own propagation)
 * toggles **Collapse** directly (#97's bug 1: a click used to toggle the
 * same `armed` flag hover already controlled, so a click while hovering
 * immediately disarmed the cluster under the pointer and the just-revealed
 * buttons vanished mid-click).
 *
 * The rail's node is *also* the Done all trigger — hovering or focusing it
 * (never the header at large) previews the group: `onPreview` bubbles to
 * `VirtualizedThreadList`, which force-arms every row in this one group
 * (`ThreadRow`'s `previewArmed`), and this component mirrors the same
 * signal onto its own `data-group-preview` so `mail.css` lights the
 * header's rail segment and every row segment off the one identical
 * condition (#97's bug 2 — the header side used to light on the broader
 * `data-armed`, one hover target for the header's own spine and a
 * different one for every row's).
 *
 * A touch-only pointer has no hover to reveal any of this (#134,
 * `hoverCapable` — `useHoverCapable()`'s `(hover: hover) and (pointer:
 * fine)`, not a viewport breakpoint), so the rail and the trailing actions
 * go unrendered there — gutter included — and `.gh-overflow` takes their
 * place instead, opening a `Sheet` listing Done all / Mark all read /
 * Collapse as plain rows — previewing the group (and its spine) for as
 * long as the sheet stays open, the touch equivalent of hovering the rail
 * node. Exactly one of the two sets renders on any device.
 */
function GroupHeaderCluster({
  label,
  loadedCount,
  trueCount,
  collapsed,
  onToggleCollapsed,
  bulk,
  hoverCapable = true,
}: {
  label: string;
  loadedCount: number;
  trueCount: number | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  bulk?: GroupHeaderClusterBulk;
  /** `useHoverCapable()` (#134): gates the rail's Done-all node and the trailing bulk actions (Mark all read, Collapse) — both hover-only — off in favor of `.gh-overflow`'s Sheet, touch's own entry to the same three actions. Defaults `true` for a caller with no capability read above it. */
  hoverCapable?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [preview, setPreview] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const count = trueCount ?? loadedCount;

  const arm = useCallback(() => {
    setArmed(true);
    bulk?.onArm();
  }, [bulk]);
  const disarm = useCallback(() => setArmed(false), []);

  const setPreviewing = useCallback(
    (active: boolean) => {
      setPreview(active);
      bulk?.onPreview(active);
    },
    [bulk],
  );

  const openSheet = useCallback(() => {
    bulk?.onArm();
    setPreviewing(true);
    setSheetOpen(true);
  }, [bulk, setPreviewing]);

  const closeSheet = useCallback(
    (open: boolean) => {
      setSheetOpen(open);
      if (!open) setPreviewing(false);
    },
    [setPreviewing],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus arm the cluster (#66); clicking its own background toggles Collapse (#97), a mouse convenience layered on the real, independently focusable `<button>` below that does the same thing. Every other control here is its own real button too.
    // biome-ignore lint/a11y/useKeyWithClickEvents: this `onClick` duplicates the `.group-collapse` button below rather than adding a keyboard-inaccessible action — a keyboard User reaches the identical toggle by Tabbing to that real, independently operable `<button>`.
    <div
      className="group-header-cluster"
      data-armed={armed}
      data-collapsed={collapsed}
      data-group-preview={preview}
      onMouseEnter={arm}
      onMouseLeave={disarm}
      onFocus={arm}
      onBlur={(event) => {
        // A focus move that stays inside the cluster (the rail node → Mark
        // all read, say) must not disarm it mid-Tab.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) disarm();
      }}
      onClick={onToggleCollapsed}
    >
      {hoverCapable ? (
        <span className="gh-rail">
          {bulk ? (
            <button
              type="button"
              className="gh-node"
              aria-label={`Done with ${label}`}
              title="Done all"
              onMouseEnter={() => setPreviewing(true)}
              onMouseLeave={() => setPreviewing(false)}
              onFocus={() => setPreviewing(true)}
              onBlur={() => setPreviewing(false)}
              onClick={(event) => {
                event.stopPropagation();
                bulk.onDoneAll();
              }}
            >
              <Check size={12} />
            </button>
          ) : null}
        </span>
      ) : null}
      <span className="group-header-label">{label}</span>
      <span className="group-header-count">{count}</span>
      <span className="gh-spacer" />
      {/* #295: a collapsed group's own at-rest tell — non-interactive, and
          gone the moment the cluster arms, when the real Expand control (or
          touch's overflow Sheet) already says the same thing. */}
      {collapsed && !armed ? (
        <ChevronDown size={13} className="group-collapsed-indicator" aria-hidden="true" />
      ) : null}
      {hoverCapable ? (
        <div className="bulk-actions">
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
              <MailOpen size={13} />
            </button>
          ) : null}
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
            {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="gh-overflow"
          aria-label={`More actions for ${label}`}
          title="More"
          onClick={(event) => {
            event.stopPropagation();
            openSheet();
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
      <Sheet open={sheetOpen} onOpenChange={closeSheet}>
        <SheetContent side="bottom" className="group-header-sheet">
          <SheetHeader className="sr-only">
            <SheetTitle>{label}</SheetTitle>
            <SheetDescription>Actions for this group.</SheetDescription>
          </SheetHeader>
          <div className="group-sheet-actions">
            {bulk ? (
              <button
                type="button"
                className="group-sheet-action"
                onClick={() => {
                  bulk.onDoneAll();
                  setSheetOpen(false);
                  setPreviewing(false);
                }}
              >
                <Check size={14} /> Done all
              </button>
            ) : null}
            {bulk ? (
              <button
                type="button"
                className="group-sheet-action"
                onClick={() => {
                  bulk.onMarkAllRead();
                  setSheetOpen(false);
                  setPreviewing(false);
                }}
              >
                <MailOpen size={14} /> Mark all read
              </button>
            ) : null}
            <button
              type="button"
              className="group-sheet-action"
              onClick={() => {
                onToggleCollapsed();
                setSheetOpen(false);
                setPreviewing(false);
              }}
            >
              {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              {collapsed ? "Expand" : "Collapse"}
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
