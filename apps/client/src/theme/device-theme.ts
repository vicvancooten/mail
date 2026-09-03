/**
 * Appearance is a **Device Preference** (#72, CONTEXT.md), not a synced
 * `Preference` — a laptop and a phone in the same hour want different
 * answers, which is exactly the reasoning `mail/device-preferences.ts`
 * already applies to view mode and list density. It lived as a synced
 * `Preference` field until this ticket amended ADR-0011 and moved it here:
 * `localStorage`, never synced, same "best-effort read/write" posture as
 * every other Device Preference.
 *
 * The header's Appearance control and Settings' own copy (poc-spec.md: "the
 * same control in Settings") both read and write through this module, so
 * neither can drift from the other — `useAppearance` is the one place either
 * mounts a subscription, and `writeTheme` is the one place either writes.
 */

import { useCallback, useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";
export const DEFAULT_THEME: Theme = "system";

const THEME_KEY = "device.theme";

function readStorage(): string | null {
  try {
    return globalThis.localStorage?.getItem(THEME_KEY) ?? null;
  } catch {
    return null;
  }
}

export function readTheme(): Theme {
  const stored = readStorage();
  return stored === "light" || stored === "dark" || stored === "system" ? stored : DEFAULT_THEME;
}

/**
 * `.light`/`.dark` on `documentElement`, matching `index.css`'s own
 * selector strategy (its docstring: "OS preference, guarded `.light`,
 * explicit `.dark`") — `system` clears both classes and leaves
 * `prefers-color-scheme` to decide.
 */
export function applyTheme(theme: Theme): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.classList.toggle("light", theme === "light");
  root.classList.toggle("dark", theme === "dark");
}

/** Every mounted `useAppearance` re-renders on a write, from any tab that made it — a `writeTheme` in the header must reach a `useAppearance` in Settings the same instant, and the reverse. */
const listeners = new Set<() => void>();

export function writeTheme(theme: Theme): void {
  try {
    globalThis.localStorage?.setItem(THEME_KEY, theme);
  } catch {
    // Best-effort; see `mail/device-preferences.ts`'s own docstring.
  }
  applyTheme(theme);
  for (const listener of listeners) listener();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The header's Appearance control and Settings' copy both call this — one subscription shape, so a write from either reaches both instantly. */
export function useAppearance(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => DEFAULT_THEME);
  const setTheme = useCallback((next: Theme) => writeTheme(next), []);
  return [theme, setTheme];
}
