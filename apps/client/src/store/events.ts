import type { Event } from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useState } from "react";
import { fetchEventRange } from "../api/calendar-events.js";
import { localCache } from "./local-cache.js";

export interface EventWindowEdges {
  start: string;
  end: string;
}

/**
 * The Event Window's edges as last reported by an `Event` sync round (#229,
 * `db.ts#EventWindow`'s own doc comment) — `null` until the first round ever
 * lands one, treated the same as "the window isn't known yet" by every
 * caller here (that doc comment's own line).
 */
export function useEventWindow(): EventWindowEdges | null {
  return useEventWindowState().window;
}

/**
 * `useEventWindow`'s own state, plus `loaded`: `useLiveQuery`'s IndexedDB
 * read resolves one tick after mount, and until it does there is a genuine
 * difference between "the window row doesn't exist yet" and "this hasn't
 * asked yet" — `useEventsForRange` needs that difference so it doesn't fire
 * an on-demand fetch for a range the Local Cache already covers, purely
 * because the read hadn't come back yet.
 */
function useEventWindowState(): { window: EventWindowEdges | null; loaded: boolean } {
  const loading = useMemo(() => Symbol("loading"), []);
  const row = useLiveQuery(() => localCache().eventWindows.get("current"), [], loading);
  if (row === loading) return { window: null, loaded: false };
  const found = row as { start: string; end: string } | undefined;
  return { window: found ? { start: found.start, end: found.end } : null, loaded: true };
}

/**
 * Every Occurrence in the Local Cache (#231): the Event Window (`events.ts`,
 * ADR-0025) already bounds how many rows exist, so — like `notes.ts`/
 * `calendars.ts` — this reads the whole `events` table rather than a
 * server-paged slice; `calendar-occurrences.ts#bucketEventsByDay` is what
 * narrows it down to one view's own visible days. Kept for callers that
 * genuinely want the whole synced Event Window unfiltered by range (none do
 * today; `useEventsForRange` is what the grid uses, #232).
 */
export function useEvents(): Event[] | undefined {
  return useLiveQuery(() => localCache().events.toArray(), []);
}

/** One Occurrence by its own id (`<seriesId>@<originalStart>`) — the Event editor's own lookup (#233) when opening an existing Occurrence, whether from a grid click or a deep link. */
export function useEvent(id: string | null): Event | undefined {
  return useLiveQuery(() => readEvent(id), [id]);
}

export async function readEvent(id: string | null): Promise<Event | undefined> {
  if (id === null) return undefined;
  return localCache().events.get(id);
}

/** Whether `id` names an Occurrence still in the Local Cache — `notes.ts#noteExists`'s own shape, the route guard `routes.tsx#calendarEventRoute` needs for a `/calendar/<seriesId>@<originalStart>` deep link that resolves to nothing. */
export async function eventExists(id: string): Promise<boolean> {
  return (await readEvent(id)) !== undefined;
}

/**
 * Fetches `GET /calendars/events` for `[start, end)` whenever that pair
 * changes, `null` while either edge is `null` (nothing to fetch) or the
 * request hasn't resolved yet for the current pair — never a stale
 * previous-range result. Held only in this hook's own state (never the
 * Local Cache — see `useEventsForRange`'s own doc comment for why).
 */
function useFetchedRange(start: string | null, end: string | null): Event[] | null {
  const [result, setResult] = useState<{ start: string; end: string; events: Event[] } | null>(
    null,
  );

  useEffect(() => {
    if (start == null || end == null) return;
    let cancelled = false;
    fetchEventRange(start, end).then(
      (response) => {
        if (!cancelled) setResult({ start, end, events: response.events });
      },
      () => {
        if (!cancelled) setResult(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [start, end]);

  if (start == null || end == null) return null;
  return result && result.start === start && result.end === end ? result.events : null;
}

export interface EventsForRange {
  /** The Local Cache's own Occurrences, plus any fetched-on-demand ones for the pieces of `[rangeStart, rangeEnd)` the Event Window doesn't cover. */
  events: Event[];
  /** Whether any part of the requested range falls outside the synced Event Window — the grid's cue to draw the window edge (#232's acceptance line) rather than infer it. */
  outsideWindow: boolean;
  window: EventWindowEdges | null;
}

function mergeById(cached: readonly Event[], fetched: readonly Event[] | null): Event[] {
  if (!fetched || fetched.length === 0) return [...cached];
  const merged = [...cached];
  const seen = new Set(merged.map((event) => event.id));
  for (const event of fetched) {
    if (!seen.has(event.id)) {
      merged.push(event);
      seen.add(event.id);
    }
  }
  return merged;
}

/**
 * Occurrences for one visible range (#232). Inside the Event Window this is
 * exactly `useEvents()` was before this ticket — the Local Cache, reactive,
 * offline-editable. A range that reaches outside it is fetched on demand
 * from `GET /calendars/events` and merged in alongside the cached
 * Occurrences, rather than replacing them, so navigating back inside the
 * window needs no reload (this ticket's acceptance line): the Local Cache's
 * own `useLiveQuery` never stopped being live.
 *
 * Fetched Occurrences are held only in `useFetchedRange`'s own state, never
 * written to the Local Cache — the range they came from is not what
 * `db.eventWindows` reports, so caching them would silently claim a wider
 * Event Window than the Sync Backend actually promised. An Occurrence
 * outside the window therefore renders without the pending-mutation overlay
 * #233's authoring path lays over cached rows — `EventEditorPopover` and the
 * series split/delete paths all write through the ordinary mutation queue,
 * which only ever touches the Local Cache.
 */
export function useEventsForRange(rangeStart: string, rangeEnd: string): EventsForRange {
  const cached = useLiveQuery(() => localCache().events.toArray(), []) ?? [];
  const { window, loaded } = useEventWindowState();

  // While the window's own read is still in flight, assume the range is
  // covered rather than firing a fetch that a tick later turns out to have
  // been unnecessary — `loaded` flips once, at most a beat after mount.
  const beforeStart = loaded && (!window || rangeStart < window.start) ? rangeStart : null;
  const beforeEnd = !window ? rangeEnd : rangeEnd < window.start ? rangeEnd : window.start;
  const afterStart =
    loaded && window && rangeEnd > window.end
      ? rangeStart > window.end
        ? rangeStart
        : window.end
      : null;
  const afterEnd = afterStart != null ? rangeEnd : null;

  const fetchedBefore = useFetchedRange(beforeStart, beforeStart != null ? beforeEnd : null);
  const fetchedAfter = useFetchedRange(afterStart, afterEnd);

  const outsideWindow = beforeStart != null || afterStart != null;
  const events = mergeById(mergeById(cached, fetchedBefore), fetchedAfter);

  return { events, outsideWindow, window };
}
