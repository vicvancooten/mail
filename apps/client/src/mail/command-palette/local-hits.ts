import type { Note, Task } from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { deriveNoteTitle, flattenDocumentText } from "../../notes/note-text.js";
import { readAllTasks, readNotes } from "../../store/index.js";
import { taskSearchText } from "../../tasks/task-text.js";

/**
 * The Command Palette's local hits (#196, ADR-0023's "Apps whose collections
 * replicate whole contribute local hits to the Command Palette, beneath
 * commands and mail hits"). Notes was the first caller; Tasks (#262) is the
 * proof the mechanism really is generic — both join by adding their own
 * `LocalHitSource` to `LOCAL_HIT_SOURCES`, never by teaching
 * `CommandPalette.tsx` a second mechanism.
 *
 * Matched against the Local Cache alone (`rows`, a plain read of an
 * already-whole-replicated Dexie table) — never the Search Index or a Sync
 * Backend round trip, which is the whole point of a collection being
 * "replicated whole" in the first place (ADR-0016 is for Mail's bounded
 * window; this is its opposite).
 */

/** The Palette's own generic shape for a local hit — what `CommandPalette.tsx` renders and navigates on, with no per-App fields of its own. */
export interface LocalHit {
  /** Stable across renders — `${section}:${row's own id}`. */
  key: string;
  /** The Palette group heading this hit renders under — "Notes" today. */
  section: string;
  /** The row's derived title, whatever "derived" means for that collection (Notes: `deriveNoteTitle`'s own "Untitled Note" fallback). */
  title: string;
  /**
   * Where selecting the hit navigates — a route's own `to` path and its
   * params, exactly the shape `useNavigate()`'s `navigate()` call takes.
   * Left untyped against the route tree on purpose: this module has no
   * business knowing every App's routes, so the one place that trusts a
   * source's own declared path is `runOpenLocalHit` below — the same
   * "erase the per-collection type once, at the boundary" idiom
   * `sync/collection-registry.ts#asApplyUserDelta` already uses.
   */
  to: string;
  params: Record<string, string>;
  /**
   * A short label shown beside the title (`command-palette-hit-badge`, the
   * same class a mail hit's gatekeeper badge already uses) — Tasks' own
   * "Done" for a completed Task (#262's "Completed Tasks appear marked").
   * Omitted where a source has nothing to mark a hit with (Notes: every hit
   * is just a Note).
   */
  badge?: string;
}

/** One collection's own declaration into the mechanism — `Row` stays fully typed within a source; only `LOCAL_HIT_SOURCES` below erases it. */
interface LocalHitSource<Row> {
  section: string;
  /** Every row the collection currently holds — a plain Local Cache read, live-queried by the caller so a hit list stays current as the collection changes underneath it. */
  rows: () => Promise<readonly Row[]>;
  /**
   * False for a row that must never surface as a hit. Checked before
   * `matchText`, so an ineligible row's text is never even compared.
   */
  isEligible: (row: Row) => boolean;
  /** The row's whole searchable text (the ticket's "a hit can come from any block", not only the title). */
  matchText: (row: Row) => string;
  /** Turns a matching row into the Palette's own generic `LocalHit`. */
  toHit: (row: Row) => LocalHit;
  /**
   * Orders this source's own matches, ascending — never applied across
   * sources (`CommandPalette.tsx`'s own "ranked beneath commands and mail
   * hits simply by being the Group rendered below" covers that). Omitted
   * for a source with nothing to differentiate matches by (Notes: every
   * match is equally "a Note"); Tasks (#262) uses this to rank a completed
   * Task below open ones.
   */
  compare?: (a: Row, b: Row) => number;
  /**
   * Where this section's own "See all results" row narrows to, given the
   * committed query — omitted for a source with no filterable view of its
   * own to narrow into (Notes: a hit already opens its own dialog; the
   * grid's Label chips are its only filter). Tasks (#262) is the first
   * source to provide this: "Label and List filters are filters on a view,"
   * and the query becomes one more, read straight off `?q=` rather than a
   * search field the Tasks App grows for itself.
   */
  seeAllTo?: (query: string) => { to: string; search: Record<string, string> };
}

/** `LocalHitSource<Row>` reduced to what the Palette actually calls — the erasure boundary `Row` never crosses. */
interface RegisteredLocalHitSource {
  section: string;
  search: (needle: string) => Promise<LocalHit[]>;
  seeAllTo?: (query: string) => { to: string; search: Record<string, string> };
}

function registerLocalHitSource<Row>(source: LocalHitSource<Row>): RegisteredLocalHitSource {
  return {
    section: source.section,
    async search(needle) {
      const rows = await source.rows();
      const matches = rows.filter(
        (row) => source.isEligible(row) && source.matchText(row).toLowerCase().includes(needle),
      );
      const ordered = source.compare ? [...matches].sort(source.compare) : matches;
      return ordered.map(source.toHit);
    },
    seeAllTo: source.seeAllTo,
  };
}

const NOTES_SOURCE: LocalHitSource<Note> = {
  section: "Notes",
  rows: readNotes,
  isEligible: (note) => note.deletedAt === null,
  matchText: (note) => flattenDocumentText(note.document),
  toHit: (note) => ({
    key: `notes:${note.id}`,
    section: "Notes",
    title: deriveNoteTitle(note.document),
    to: "/notes/$noteId",
    params: { noteId: note.id },
  }),
};

/**
 * Tasks (#262) — the mechanism's proof that it generalizes past Notes.
 * `readAllTasks` already excludes soft-deleted Tasks and ones whose own List
 * is soft-deleted (`store/tasks.ts`'s own doc comment); `isEligible` here is
 * the same defense-in-depth `NOTES_SOURCE` gives a read that already
 * filters, not a second real gate.
 */
const TASKS_SOURCE: LocalHitSource<Task> = {
  section: "Tasks",
  rows: readAllTasks,
  isEligible: (task) => task.deletedAt === null,
  matchText: taskSearchText,
  toHit: (task) => ({
    key: `tasks:${task.id}`,
    section: "Tasks",
    title: task.title || "(untitled)",
    badge: task.completed ? "Done" : undefined,
    to: "/tasks/$taskId",
    params: { taskId: task.id },
  }),
  // Open before completed — `Number(false) < Number(true)`, and `.sort` is a
  // stable sort, so two Tasks of the same completion state keep whatever
  // order `rows()` handed them in.
  compare: (a, b) => Number(a.completed) - Number(b.completed),
  seeAllTo: (query) => ({ to: "/tasks", search: { q: query } }),
};

const LOCAL_HIT_SOURCES: readonly RegisteredLocalHitSource[] = [
  registerLocalHitSource(NOTES_SOURCE),
  registerLocalHitSource(TASKS_SOURCE),
];

/** Every local hit matching `query`, across every registered source — unranked and uncapped; `CommandPalette.tsx` caps it the same way it already caps mail hits. */
export async function searchLocalHits(query: string): Promise<LocalHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const bySource = await Promise.all(LOCAL_HIT_SOURCES.map((source) => source.search(needle)));
  return bySource.flat();
}

/**
 * Where a section's own "See all results" row narrows to (`CommandPalette.tsx`),
 * looked up by the section name a hit already carries — `null` for a section
 * with no `seeAllTo` of its own (Notes today), which is what tells the
 * Palette not to render the row at all.
 */
export function seeAllRouteFor(
  section: string,
  query: string,
): { to: string; search: Record<string, string> } | null {
  const source = LOCAL_HIT_SOURCES.find((candidate) => candidate.section === section);
  return source?.seeAllTo ? source.seeAllTo(query) : null;
}

/**
 * The Palette's own reactive read (`CommandPalette.tsx`): `useLiveQuery`
 * re-runs `searchLocalHits` whenever a table it read from changes — Dexie's
 * own dependency tracking, not a manual subscription per collection — the
 * same "component-facing read" shape `store/notes.ts#useNotes` already
 * gives the grid.
 */
export function useLocalHits(query: string): LocalHit[] {
  return useLiveQuery(() => searchLocalHits(query), [query]) ?? [];
}
