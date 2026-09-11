import type { SeriesSave, SeriesSaveOutcome } from "@mail/shared";
import { applySeriesSave } from "../calendars/series-store.js";
import type { Db } from "../db/client.js";

/**
 * Applies one User's queued Series body autosaves (#233) — `note-store.ts
 * #flushNoteSaves`'s own shape: `saves` carries at most one entry per Series
 * (`store/series.ts`'s own coalescing queue never holds more), and — the
 * same "never rejects" posture `seriesSaveSchema`'s own doc comment gives —
 * every write applies unconditionally; `applySeriesSave` is what carries
 * the one guard (a different User's row is left untouched) and the
 * re-materialise-immediately side effect.
 */
export async function flushSeriesSaves(
  db: Db,
  userId: string,
  saves: SeriesSave[],
): Promise<SeriesSaveOutcome[]> {
  const outcomes: SeriesSaveOutcome[] = [];
  for (const save of saves) {
    await applySeriesSave(db, userId, save);
    outcomes.push({ id: save.id, saveId: save.saveId, status: "applied" });
  }
  return outcomes;
}
