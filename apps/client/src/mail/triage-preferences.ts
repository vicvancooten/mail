/**
 * Auto-advance direction (#42). Unlike `device-preferences.ts`'s settings,
 * this one is **not** a Device Preference by design (CONTEXT.md,
 * poc-spec.md §Preferences): direction is meant to sync at User scope
 * alongside theme and Undo Send delay, the same everywhere the User signs
 * in. The Preferences ticket that adds that synced collection doesn't exist
 * yet, so this is the ticket's own "inline default" stand-in — a plain
 * `localStorage` read/write, same mechanics as `device-preferences.ts`
 * (best-effort, never worth surfacing an error over), but kept in its own
 * module so nothing mistakes it for a Device Preference, and so replacing
 * it later is a change to one file's insides, not a rename hunt.
 */

export type AdvanceDirection = "older" | "newer";
export const DEFAULT_ADVANCE_DIRECTION: AdvanceDirection = "older";

const ADVANCE_DIRECTION_KEY = "mail.triagePref.advanceDirection";

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Best-effort; see module docstring.
  }
}

export function readAdvanceDirection(): AdvanceDirection {
  const stored = readStorage(ADVANCE_DIRECTION_KEY);
  return stored === "older" || stored === "newer" ? stored : DEFAULT_ADVANCE_DIRECTION;
}

export function writeAdvanceDirection(direction: AdvanceDirection): void {
  writeStorage(ADVANCE_DIRECTION_KEY, direction);
}
