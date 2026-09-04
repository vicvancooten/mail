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
 * same control in Settings"; `settings/ThisDeviceSection.tsx`, #99) both
 * read and write through this module, so neither can drift from the other —
 * `useAppearance` is the one place either mounts a subscription, and
 * `writeTheme` is the one place either writes.
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
 * The Hub's own ground in each appearance — `--color-surface-strong` from
 * `@mail/design-tokens`, the colour `router/shell.css`'s `.app-header`
 * paints. Literal hex because `<meta name="theme-color">` cannot read a
 * custom property; `index.html` carries the same two values for the cold
 * load, and both have to move together if the token ever does.
 */
const HUB_COLOR: Record<"light" | "dark", string> = {
  light: "#f5f5f8",
  dark: "#08090b",
};

/**
 * The browser's own chrome continues the Hub (CONTEXT.md's Hub entry: "the
 * browser's own chrome takes the Hub's colour, so the frame reads as one
 * continuous piece"). `index.html` states that as two `prefers-color-scheme`
 * -scoped `<meta name="theme-color">` tags, which is right for `system` and
 * wrong for everything else: Appearance is a Device Preference, so a User on
 * a dark OS who picks `light` in the Hub got a near-black browser chrome
 * above a light app — the reported "theme colour is black rather than the
 * Hub's". A media query cannot see that choice, so this rewrites both tags'
 * `content` instead of adding a third: whichever one the browser matches
 * then carries the appearance actually on screen, and `system` puts the
 * per-scheme pair back.
 */
function applyThemeColor(theme: Theme): void {
  const metas = globalThis.document?.querySelectorAll?.('meta[name="theme-color"]');
  if (!metas) return;
  for (const meta of metas) {
    const scheme = (meta.getAttribute("media") ?? "").includes("dark") ? "dark" : "light";
    meta.setAttribute("content", HUB_COLOR[theme === "system" ? scheme : theme]);
  }
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
  applyThemeColor(theme);
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

/**
 * The header's own appearance toggle (#86, the comp's `#theme-toggle`): one
 * button that flips between light and dark, rather than the three-way
 * choice `ThisDeviceSection` (a `<select>`) and the avatar menu (a radio
 * group) both render. `system` has no icon of its own to show, so the
 * toggle reports the *resolved*
 * appearance — what the User is actually looking at — and a press writes
 * the opposite as an explicit choice, the same move the comp makes.
 *
 * Reads `prefers-color-scheme` only while the stored preference is
 * `system`; an explicit `light`/`dark` answers without consulting the OS at
 * all.
 */
export function useResolvedAppearance(): [boolean, () => void] {
  const [theme, setTheme] = useAppearance();
  const systemDark = useSyncExternalStore(subscribeSystemDark, readSystemDark, () => false);
  const resolvedDark = theme === "system" ? systemDark : theme === "dark";
  const toggle = useCallback(
    () => setTheme(resolvedDark ? "light" : "dark"),
    [resolvedDark, setTheme],
  );
  return [resolvedDark, toggle];
}

function systemDarkQuery(): MediaQueryList | null {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
}

function readSystemDark(): boolean {
  return systemDarkQuery()?.matches ?? false;
}

function subscribeSystemDark(listener: () => void): () => void {
  const query = systemDarkQuery();
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}
