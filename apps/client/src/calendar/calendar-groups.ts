import type { Calendar, ConnectedAccount, Provider } from "@mail/shared";

/**
 * One row the Calendar list groups under (#300): the Local group first
 * (`key: "local"`, no Provider badge), then one group per Connected Account
 * that owns at least one mirrored Calendar, each carrying its own Provider
 * so `CalendarSlideOver.tsx` can render a badge beside the group's label.
 */
export interface CalendarGroup {
  key: string;
  label: string;
  /** `null` for the Local group — it has no Provider to badge. */
  provider: Provider | null;
  calendars: readonly Calendar[];
}

/**
 * `CalendarSlideOver.tsx`'s own grouping (#300's acceptance line: "the list
 * shows a Local group first, then one group per Connected Account with its
 * provider badge, each calendar under the right group"). `readCalendars`
 * (`store/calendars.ts`) already sorts Local first and groups each Connected
 * Account's own rows together — this only turns that flat, already-sorted
 * list into the group shape the slide-over renders, rather than re-deriving
 * order of its own.
 *
 * A Connected Account with no Calendar of its own (never discovered one, or
 * every discovered Calendar was unmirrored — `CalendarMirrorChecklist.tsx`'s
 * own read side) gets no group at all: there is nothing under it to show.
 * A Calendar whose `connectedAccountId` names an account gone from
 * `connectedAccounts` (the same "stale id" case `resolveAccountScope`
 * guards elsewhere) still gets a group, labelled by its own id — better than
 * silently dropping a Calendar the User can still see Events on.
 */
export function groupCalendarsByAccount(
  calendars: readonly Calendar[],
  connectedAccounts: readonly ConnectedAccount[],
): CalendarGroup[] {
  const accountsById = new Map(connectedAccounts.map((account) => [account.id, account]));
  const groupsByKey = new Map<
    string,
    { key: string; label: string; provider: Provider | null; calendars: Calendar[] }
  >();
  const order: string[] = [];

  for (const calendar of calendars) {
    const key = calendar.origin.type === "local" ? "local" : calendar.origin.connectedAccountId;
    let group = groupsByKey.get(key);
    if (!group) {
      const account = calendar.origin.type === "local" ? null : accountsById.get(key);
      group = {
        key,
        label: calendar.origin.type === "local" ? "Local" : (account?.identity ?? key),
        provider: account?.provider ?? null,
        calendars: [],
      };
      groupsByKey.set(key, group);
      order.push(key);
    }
    group.calendars.push(calendar);
  }

  return order.map((key) => groupsByKey.get(key)!);
}
