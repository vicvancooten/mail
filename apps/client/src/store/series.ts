import type {
  EventReminder,
  SeriesAttendee,
  SeriesOverride,
  SeriesSave,
  SeriesSaveOutcome,
} from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { fetchSeries } from "../api/calendars.js";
import type { CachedSeries, PendingSeriesSave } from "./db.js";
import { localCache } from "./local-cache.js";
import { sessionUserId } from "./session.js";
import { generateUlid } from "./ulid.js";
import { enqueueUserMutation } from "./user-mutation-queue.js";

/**
 * A Series' on-demand fetch, cached (#233) — `store/notes.ts`'s own
 * component-facing read/write split, adapted for a Series' one real
 * difference: it never rides `POST /sync` (`@mail/shared#seriesSchema`'s
 * own doc comment), so `readSeries`/`useSeries` read `db.ts#seriesCache`
 * rather than a synced collection, and `hydrateSeries` is what fills that
 * cache the first time an Event editor opens one.
 *
 * Structural actions (create, permanent delete, soft-delete/restore, one
 * Occurrence's `exdate`) ride the User-scoped Optimistic Action queue
 * (`user-mutation-queue.ts`) with real inverses (ADR-0019); the whole body
 * — title, rules, attendees, description, Location, Overrides — rides
 * `pendingSeriesSaves` instead, last-write-wins, never rejected, the exact
 * split `notes.ts`'s own doc comment draws for a Note.
 */

/** A fresh Series id, mintable before any content exists — `newNoteId`'s own "offline-derivable address" shape. */
export function newSeriesId(): string {
  return generateUlid();
}

/** A fresh Override id, for a brand-new "this Occurrence only" edit. */
export function newOverrideId(): string {
  return generateUlid();
}

export function useSeries(id: string | null): CachedSeries | undefined {
  return useLiveQuery(() => readSeries(id), [id]);
}

export async function readSeries(id: string | null): Promise<CachedSeries | undefined> {
  if (id === null) return undefined;
  return localCache().seriesCache.get(id);
}

/**
 * Fetches a Series' body through `GET /calendars/:calendarId/series/:seriesId`
 * (`api/calendars.ts#fetchSeries`) and caches it — the Event editor's own
 * hydration step whenever it opens an Occurrence whose Series it does not
 * already hold, or whose cached copy might be stale (a concurrent edit from
 * another device). Overwrites any cached row unconditionally: unlike a
 * synced collection there is no local overlay to preserve across this,
 * except a still-unflushed `pendingSeriesSaves` row, which stays queued and
 * flushes independently regardless of what this refetch just wrote.
 */
export async function hydrateSeries(calendarId: string, seriesId: string): Promise<CachedSeries> {
  const { series, overrides } = await fetchSeries(calendarId, seriesId);
  const cached: CachedSeries = { ...series, overrides };
  await localCache().seriesCache.put(cached);
  return cached;
}

/**
 * Creates a Series (#233): writes the empty skeleton row optimistically —
 * no rules, no attendees, `dtstart`/`durationMs` zeroed until the first
 * `saveSeriesBody` call (typed moments later, from the same "More details"
 * form the popover already holds open) — and enqueues the `createSeries`
 * intent whose real inverse is `deleteSeries` (ADR-0019). `id` is minted by
 * the caller (`newSeriesId`) before this is ever called, `createNote`'s own
 * shape.
 */
export async function createSeries(id: string, calendarId: string): Promise<void> {
  const userId = sessionUserId();
  if (userId === null) return;
  const now = new Date().toISOString();
  const skeleton: CachedSeries = {
    id,
    userId,
    calendarId,
    uid: "",
    sequence: 0,
    title: "",
    description: null,
    location: null,
    allDay: false,
    floating: false,
    tzid: null,
    dtstart: now,
    durationMs: 0,
    rrules: [],
    rdates: [],
    exdates: [],
    transparency: "opaque",
    attendees: [],
    reminders: [],
    upstreamId: null,
    etag: null,
    createdAt: now,
    updatedAt: now,
    overrides: [],
  };
  await localCache().seriesCache.put(skeleton);
  await enqueueUserMutation({ type: "createSeries", seriesId: id, calendarId });
}

/**
 * Deletes a Series (#233): permanent, the real inverse of `createSeries`
 * (ADR-0019) — used only to undo a still-in-progress create, never the
 * User-facing "Delete" (`trashSeries` below). `deleteNote`'s own shape:
 * the local row (and whatever body save was still queued for it) is gone
 * the instant this is called.
 */
export async function deleteSeries(id: string): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.seriesCache, db.pendingSeriesSaves], async () => {
    await db.seriesCache.delete(id);
    await db.pendingSeriesSaves.delete(id);
  });
  await enqueueUserMutation({ type: "deleteSeries", seriesId: id });
}

/**
 * Deletes a Series (#233's own "Delete", not the permanent create-undo
 * above): the real inverse is `restoreSeries`. The Sync Backend tears the
 * Series' Occurrences down synchronously (`series-store.ts#trashSeries`),
 * so this needs no local overlay of its own beyond enqueuing the intent —
 * the very next sync round the same call wakes (`enqueueUserMutation`'s own
 * doc comment) reflects the grid going empty.
 */
export async function trashSeries(id: string): Promise<void> {
  await enqueueUserMutation({ type: "trashSeries", seriesId: id });
}

/** Restores a Series out of its 24-hour snapshot, the real inverse of `trashSeries`. */
export async function restoreSeries(id: string): Promise<void> {
  await enqueueUserMutation({ type: "restoreSeries", seriesId: id });
}

/**
 * Deletes one Occurrence (#233's own acceptance line: "Deleting one
 * Occurrence adds an `exdate`") — the real inverse is `removeExdate`. Like
 * `trashSeries` above, needs no local overlay: the Occurrence row itself is
 * torn down server-side and disappears from the grid on the next sync round.
 */
export async function addExdate(seriesId: string, exdate: string): Promise<void> {
  await enqueueUserMutation({ type: "addExdate", seriesId, exdate });
}

/** Undo of `addExdate`, its real inverse. */
export async function removeExdate(seriesId: string, exdate: string): Promise<void> {
  await enqueueUserMutation({ type: "removeExdate", seriesId, exdate });
}

/**
 * Moves a Series to a different Calendar (#238): copy plus delete with a
 * fresh UID, `newSeriesId`'s own shape — minted by the caller
 * (`newSeriesId()`) before this is ever called, exactly like `createSeries`.
 * Needs no local overlay: `series-store.ts#moveSeries` tears the source
 * Series' Occurrences down and materialises the destination's synchronously,
 * so — like `trashSeries` — the very next sync round this call wakes reflects
 * both sides. There is no dedicated `unmoveSeries`: Undo is
 * `restoreSeries(seriesId)` paired with `trashSeries(newSeriesId)`
 * (`sync.ts#userMutationIntentSchema`'s own doc comment), both already
 * exported above.
 */
export async function moveSeries(
  seriesId: string,
  newSeriesId: string,
  calendarId: string,
): Promise<void> {
  await enqueueUserMutation({ type: "moveSeries", seriesId, newSeriesId, calendarId });
}

/** What one `saveSeriesBody` call carries — every field `@mail/shared#seriesSaveSchema` names except the ids `saveSeriesBody`'s own parameters already supply. */
export interface SeriesBodyFields {
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  floating: boolean;
  tzid: string | null;
  dtstart: string;
  durationMs: number;
  rrules: string[];
  rdates: string[];
  exdates: string[];
  transparency: "opaque" | "transparent";
  attendees: SeriesAttendee[];
  /** ADR-0028's per-Event Reminders — `@mail/shared#seriesSaveSchema.reminders`'s own doc comment. */
  reminders: EventReminder[];
  /** No `seriesId` — the same "implied by the containing save's own id" shape `@mail/shared#seriesSaveSchema`'s `overrides` field has. */
  overrides: Omit<SeriesOverride, "seriesId">[];
}

/**
 * Writes one Series body save (#233) — `saveNoteBody`'s own shape: the
 * durable cache row and the coalescing `pendingSeriesSaves` queue are
 * written in one transaction, and a second call for the same `id` before
 * the first has flushed simply overwrites the queued row (`put()`'s own
 * upsert semantics). Created lazily if somehow missing, the same tolerance
 * `saveNoteBody` gives this same race server-side (`applySeriesSave`).
 */
export async function saveSeriesBody(
  id: string,
  calendarId: string,
  fields: SeriesBodyFields,
  /**
   * The Send / Don't send prompt's own answer (#242, ADR-0027) — `true` (the
   * default) for a create, where there is no prompt: "Create sends `REQUEST`
   * at once." Ignored on a synced Calendar and on the very first save that
   * actually invites anyone, which the Sync Backend always sends regardless.
   */
  sendUpdate = true,
): Promise<void> {
  const db = localCache();
  const now = new Date().toISOString();
  await db.transaction("rw", [db.seriesCache, db.pendingSeriesSaves], async () => {
    const existing = await db.seriesCache.get(id);
    const userId = existing?.userId ?? sessionUserId();
    if (userId !== null) {
      const cached: CachedSeries = {
        id,
        userId,
        calendarId,
        uid: existing?.uid ?? "",
        sequence: existing?.sequence ?? 0,
        upstreamId: existing?.upstreamId ?? null,
        etag: existing?.etag ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...fields,
        overrides: fields.overrides.map((override) => ({ ...override, seriesId: id })),
      };
      await db.seriesCache.put(cached);
    }
    const pending: PendingSeriesSave = {
      seriesId: id,
      saveId: generateUlid(),
      calendarId,
      ...fields,
      queuedAt: now,
      sendUpdate,
    };
    await db.pendingSeriesSaves.put(pending);
  });
}

/** Every queued Series body save, at most one per Series. */
export async function listQueuedSeriesSaves(): Promise<PendingSeriesSave[]> {
  return localCache().pendingSeriesSaves.toArray();
}

export function toWireSeriesSave(pending: PendingSeriesSave): SeriesSave {
  return {
    id: pending.seriesId,
    saveId: pending.saveId,
    calendarId: pending.calendarId,
    title: pending.title,
    description: pending.description,
    location: pending.location,
    allDay: pending.allDay,
    floating: pending.floating,
    tzid: pending.tzid,
    dtstart: pending.dtstart,
    durationMs: pending.durationMs,
    rrules: pending.rrules,
    rdates: pending.rdates,
    exdates: pending.exdates,
    transparency: pending.transparency,
    attendees: pending.attendees,
    reminders: pending.reminders,
    overrides: pending.overrides,
    sendUpdate: pending.sendUpdate,
  };
}

/** Dequeues every body save a round trip answered for — `resolveNoteSaveOutcomes`'s own shape: only when the queued row's `saveId` still matches, so a newer coalesced save is never dequeued on a stale outcome. */
export async function resolveSeriesSaveOutcomes(
  queued: SeriesSave[],
  outcomes: SeriesSaveOutcome[],
): Promise<void> {
  const ids = new Set(queued.map((save) => save.id));
  const db = localCache();
  for (const outcome of outcomes) {
    if (!ids.has(outcome.id)) continue;
    await db.transaction("rw", db.pendingSeriesSaves, async () => {
      const stillQueued = await db.pendingSeriesSaves.get(outcome.id);
      if (!stillQueued || stillQueued.saveId !== outcome.saveId) return;
      await db.pendingSeriesSaves.delete(outcome.id);
    });
  }
}
