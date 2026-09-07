/**
 * The list's own scroll-offset memory (#142, `#133`'s Navigation decisions:
 * "scroll restoration saves the list's pixel offset when the list is left
 * [Reader opened, Stream entered, Settings visited] and restores it on
 * return"). Deliberately module-level state, not component state or
 * `localStorage`: the offset has to survive the list itself unmounting —
 * the List layout drops `VirtualizedThreadList` entirely while a Thread is
 * open (`ListView.tsx`), and leaving Mail for Stream or Settings unmounts
 * `MailSection` altogether (`router/RootLayout.tsx`'s single `<Outlet/>`,
 * a different route each time) — while staying exactly as ephemeral as
 * `MailRoute.tsx`'s own `previousThreadRef`: a reload starts fresh, same as
 * "scroll the previously open Thread into view" already did before this.
 *
 * Keyed per list identity (Account Scope + folder + label), so switching
 * between two lists never hands one the other's saved position.
 */
const offsets = new Map<string, number>();

export function scrollRestoreKey(parts: {
  folder: string;
  labelFilter: string | null;
  accountScope: readonly string[];
}): string {
  return `${parts.accountScope.join(",")}:${parts.folder}:${parts.labelFilter ?? ""}`;
}

export function saveListScrollOffset(key: string, offset: number): void {
  offsets.set(key, offset);
}

/** `null` means "no offset saved for this list" — the caller's cue to fall back to "scroll the previously open Thread into view" instead. */
export function readListScrollOffset(key: string): number | null {
  return offsets.get(key) ?? null;
}

/** Test-only: every other integration suite that opens a Thread now also writes into this module-level map as a side effect — without a reset, one test's saved offset leaks into the next test's initial mount of the same list (same Account/folder/label most fixtures share). Real callers never need this; the map is meant to outlive component unmounts for the length of a session. */
export function resetScrollOffsetsForTest(): void {
  offsets.clear();
}
