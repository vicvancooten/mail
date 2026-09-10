import type { Note } from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { deriveNoteTitle, flattenDocumentText } from "../../notes/note-text.js";
import { readNotes } from "../../store/index.js";

/**
 * The Command Palette's local hits (#196, ADR-0023's "Apps whose collections
 * replicate whole contribute local hits to the Command Palette, beneath
 * commands and mail hits"). Notes is the first caller, but nothing below
 * names it outside its own `NOTES_SOURCE` declaration — Contacts and Tasks
 * join by adding their own `LocalHitSource` to `LOCAL_HIT_SOURCES`, never by
 * teaching `CommandPalette.tsx` a second mechanism.
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
}

/** `LocalHitSource<Row>` reduced to the one operation the Palette actually calls — the erasure boundary `Row` never crosses. */
interface RegisteredLocalHitSource {
  search: (needle: string) => Promise<LocalHit[]>;
}

function registerLocalHitSource<Row>(source: LocalHitSource<Row>): RegisteredLocalHitSource {
  return {
    async search(needle) {
      const rows = await source.rows();
      const hits: LocalHit[] = [];
      for (const row of rows) {
        if (!source.isEligible(row)) continue;
        if (!source.matchText(row).toLowerCase().includes(needle)) continue;
        hits.push(source.toHit(row));
      }
      return hits;
    },
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

const LOCAL_HIT_SOURCES: readonly RegisteredLocalHitSource[] = [
  registerLocalHitSource(NOTES_SOURCE),
];

/** Every local hit matching `query`, across every registered source — unranked and uncapped; `CommandPalette.tsx` caps it the same way it already caps mail hits. */
export async function searchLocalHits(query: string): Promise<LocalHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const bySource = await Promise.all(LOCAL_HIT_SOURCES.map((source) => source.search(needle)));
  return bySource.flat();
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
