import type { Calendar } from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { localCache } from "./local-cache.js";
import { sessionUserId } from "./session.js";

/**
 * Every Calendar the signed-in User can render a grid against (#231): every
 * origin, mirrored or not, sorted **Origin then name** (#236's own
 * acceptance line) so the slide-over (`CalendarSlideOver.tsx`) groups a
 * Connected Account's Calendars together rather than interleaving them
 * alphabetically with every other Origin's. Unlike
 * `useCalendarsForConnectedAccount` above, this is not scoped to one
 * Connected Account — the grid renders every Calendar the User owns,
 * mirrored or Local alike.
 */
export function useCalendars(): Calendar[] | undefined {
  return useLiveQuery(() => readCalendars(), []);
}

/**
 * Local first (Wicket's own, always exactly the Personal Calendar plus
 * whatever else the User has created there), then each Connected Account's
 * Calendars grouped together by `connectedAccountId` — the ordering
 * `readCalendars` sorts by before falling back to name.
 */
function originSortKey(calendar: Calendar): string {
  return calendar.origin.type === "local" ? "" : `1:${calendar.origin.connectedAccountId}`;
}

export async function readCalendars(): Promise<Calendar[]> {
  const userId = sessionUserId();
  if (!userId) return [];
  const rows = await localCache().calendars.where("userId").equals(userId).toArray();
  return rows.sort(
    (left, right) =>
      originSortKey(left).localeCompare(originSortKey(right)) ||
      left.name.localeCompare(right.name),
  );
}

/**
 * Every Calendar a Connected Account's Facet has ever discovered — mirrored
 * and unmirrored alike (#235's own acceptance line: "Every discovered
 * Calendar gets a row whether or not it is mirrored"), read straight off
 * the ordinary `Calendar` collection the Local Cache already syncs whole
 * (`notes.ts`'s own "no windowing" posture). This is the checklist's read
 * side; `api/calendars.ts` is its write side, a plain request/response pair
 * rather than an Optimistic Action (this ticket's own acceptance line).
 */
export function useCalendarsForConnectedAccount(
  connectedAccountId: string,
): Calendar[] | undefined {
  return useLiveQuery(
    () => readCalendarsForConnectedAccount(connectedAccountId),
    [connectedAccountId],
  );
}

export async function readCalendarsForConnectedAccount(
  connectedAccountId: string,
): Promise<Calendar[]> {
  const rows = await localCache().calendars.toArray();
  return rows
    .filter(
      (row) =>
        row.origin.type === "connectedAccount" &&
        row.origin.connectedAccountId === connectedAccountId,
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}
