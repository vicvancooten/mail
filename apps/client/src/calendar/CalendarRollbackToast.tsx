import { useLiveQuery } from "dexie-react-hooks";
import { useEffect } from "react";
import { raiseActionToast } from "../mail/action-toast.js";
import { localCache } from "../store/local-cache.js";
import { hydrateSeries } from "../store/series.js";

/**
 * The Calendar mirror's own Rollback surface (#237, ADR-0025): "each
 * rejection writes a Rollback row, shown once per device as the existing
 * rollback toast with Retry". A world apart from `mail/RollbackToast.tsx`'s
 * own subject — that one watches *this device's* still-unsent Optimistic
 * Actions get rejected; this one watches the `Rollback` collection itself,
 * a Sync-Backend-authored fact that can arrive from a write made on an
 * entirely different device (ADR-0025's own "this is what makes a
 * rejection made on the laptop visible on the phone").
 *
 * "Once per device" is a `localStorage` set, not a server flag — every open
 * device gets its own toast the first time it *sees* a given row, exactly
 * once, even though the same row synced to every device alike; a device
 * that was offline when the rejection happened still gets shown it the
 * next time it opens, which is the whole point.
 *
 * Retry here cannot literally resend the rejected write — ADR-0025 already
 * dropped it ("merge nothing") — so it re-fetches the Series' body instead,
 * the same on-demand fetch the Event editor itself uses
 * (`store/series.ts#hydrateSeries`): confirming the local cache now agrees
 * with what the toast just told the User happened, one tap away from
 * reopening the editor to redo the edit if they still want it.
 */

const SEEN_STORAGE_KEY = "mail-calendar-rollback-seen-ids";
const DEFAULT_AUTO_DISMISS_MS = 8_000;

function readSeenIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function markSeen(seen: Set<string>, id: string): void {
  seen.add(id);
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify([...seen]));
  } catch {
    // A private window or a full quota loses the "seen" record, not the
    // rollback itself — the worst case is a toast reappearing next launch,
    // never a lost one.
  }
}

export function CalendarRollbackToast({
  autoDismissMs = DEFAULT_AUTO_DISMISS_MS,
}: {
  /** Test seam — `mail/RollbackToast.tsx`'s own knob. */
  autoDismissMs?: number;
} = {}) {
  const rollbacks = useLiveQuery(() => localCache().rollbacks.toArray(), []);

  useEffect(() => {
    if (!rollbacks) return;
    const seen = readSeenIds();
    for (const rollback of rollbacks) {
      if (seen.has(rollback.id)) continue;
      markSeen(seen, rollback.id);
      raiseActionToast({
        id: `calendar-rollback-${rollback.id}`,
        message: rollback.reason ?? "Google rejected a change to this event — reverted.",
        durationMs: autoDismissMs,
        action: {
          label: "Retry",
          onClick: () => {
            void findCalendarId(rollback.entityId).then((calendarId) => {
              if (calendarId) void hydrateSeries(calendarId, rollback.entityId);
            });
          },
        },
      });
    }
  }, [rollbacks, autoDismissMs]);

  return null;
}

/** The Series' own `calendarId`, read from whatever the cache still holds after the revert — `hydrateSeries` needs it to refetch. `null` when the cache has nothing (a device seeing this for the very first time with no prior cached copy) — Retry is then a harmless no-op rather than a crash. */
async function findCalendarId(seriesId: string): Promise<string | null> {
  const cached = await localCache().seriesCache.get(seriesId);
  return cached?.calendarId ?? null;
}
