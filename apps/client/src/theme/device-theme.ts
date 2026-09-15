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
 *
 * `public/manifest.webmanifest` carries no `theme_color` of its own (R1,
 * `docs/design/polish-pass.md`'s "Android step 2") — an installed Android
 * WebAPK paints its status bar from the manifest's `theme_color` once, at
 * install time, and simply never looks at a later `<meta name="theme-color">`
 * change again, so a User who picked Appearance after installing kept the
 * install-time colour there specifically (reported: Android Chrome; Edge on
 * Windows follows the meta correctly). With no manifest colour to freeze on,
 * Chrome has nothing to fall back to but this module's own meta, the one
 * thing that already tracks Appearance/width live. `background_color` (the
 * splash screen, painted before any script can run at all) stays — this is
 * only the status bar's own colour, which a script can still reach.
 */

import { phoneBreakpoint } from "@mail/design-tokens";
import { useCallback, useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";
export const DEFAULT_THEME: Theme = "system";

/** Exported so `pre-paint.ts` can build the inline script's literal source from the same constant rather than a second copy of the string. */
export const THEME_KEY = "device.theme";

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
 * paints at ≥768px. Literal hex because `<meta name="theme-color">` cannot
 * read a custom property; `index.html` carries the same two values for the
 * cold load, and both have to move together if the token ever does.
 */
export const HUB_COLOR: Record<"light" | "dark", string> = {
  light: "#f5f5f8",
  dark: "#08090b",
};

/**
 * Below 768px the header is no longer an opaque slab (R1,
 * `docs/design/polish-pass.md`) — it's a translucent, blurred sheet the
 * page's own ground shows through (`router/shell.css`'s `.app-header`), so
 * the browser's own chrome should continue *that* ground, `--color-bg`, not
 * the header's paint. Literal hex for the same reason `HUB_COLOR` is: a
 * meta tag can't read a custom property.
 */
export const HUB_COLOR_PHONE: Record<"light" | "dark", string> = {
  light: "#fbfbfc",
  dark: "#0c0d10",
};

/** `router/shell.css`'s one phone breakpoint (`@mail/design-tokens#phoneBreakpoint`, `use-phone-width.ts`'s own query) — a meta tag has no CSS to inherit it from, so this module reads the same query directly rather than a second, hand-copied number. `pre-paint.ts`'s literal script can't import the constant (nothing but its own literal string exists yet when it runs), so its own copy is the one place the number is spelled out again. */
function phoneThemeColorQuery(): MediaQueryList | null {
  return globalThis.matchMedia?.(`(max-width: ${phoneBreakpoint - 1}px)`) ?? null;
}

/**
 * The browser's own chrome continues the Hub (CONTEXT.md's Hub entry: "the
 * browser's own chrome takes the Hub's colour, so the frame reads as one
 * continuous piece") — a single `<meta name="theme-color">`, carrying
 * whichever ground the appearance actually on screen resolves to (#287).
 * Earlier this was a `prefers-color-scheme`-scoped *pair*, one tag per OS
 * scheme, relying on the browser to pick the right one — wrong for anything
 * but `system`, since a media query cannot see a Device Preference sitting
 * in `localStorage`: a User on a dark OS who picked `light` in the Hub got
 * the dark tag's near-black browser chrome above a light app. Finds the
 * single tag `index.html`'s pre-paint script already created (or creates
 * one, for a test/environment that skips that script) rather than assuming
 * it exists.
 *
 * R1 (`docs/design/polish-pass.md`): below 768px the ground the chrome
 * blends into is `HUB_COLOR_PHONE` (`--color-bg`, the translucent header's
 * own backdrop), not `HUB_COLOR` (`--color-surface-strong`, the opaque
 * desktop header) — `phoneThemeColorQuery()` resolves width the same way
 * `hooks/use-phone-width.ts` does, so this can never disagree with the
 * layout that actually decided which header renders.
 */
function applyThemeColor(theme: Theme): void {
  const doc = globalThis.document;
  if (!doc) return;
  let meta = doc.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = doc.createElement("meta");
    meta.setAttribute("name", "theme-color");
    doc.head.appendChild(meta);
  }
  const dark = theme === "dark" || (theme === "system" && readSystemDark());
  const palette = phoneThemeColorQuery()?.matches ? HUB_COLOR_PHONE : HUB_COLOR;
  meta.setAttribute("content", palette[dark ? "dark" : "light"]);
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

let unsubscribeSystemSync: (() => void) | null = null;

/**
 * The one place the app wires OS scheme changes to the meta/document
 * classes themselves (#287), as opposed to `useResolvedAppearance`'s own
 * `matchMedia` subscription, which only tells an already-mounted component
 * what to render — nothing previously told `applyThemeColor` to run again
 * when the OS flips scheme mid-session, so a User in `system` mode watching
 * the OS switch kept the old browser chrome colour until an explicit
 * appearance change or a reload. `main.tsx` calls this once at startup,
 * next to `applyTheme(readTheme())`; re-applies only while the stored
 * preference is still `system` at the moment the OS actually changes, so an
 * explicit `light`/`dark` choice is never overridden.
 *
 * R1: also re-applies on a width change now — rotating a phone into a
 * tablet-width landscape, say, or a resizable installed window crossing
 * 768px — since `applyThemeColor` resolves `HUB_COLOR`/`HUB_COLOR_PHONE` by
 * width and nothing else re-runs it once mounted. Unconditional (unlike the
 * dark-scheme listener above, this doesn't check the stored theme first):
 * a width crossing never conflicts with an explicit `light`/`dark` choice
 * the way an OS scheme change can, since a User's appearance choice says
 * nothing about which chrome shape they're viewing it through.
 *
 * Idempotent by replacing rather than stacking the subscription, so a test
 * can call it again after re-stubbing `matchMedia`.
 */
export function syncThemeWithSystem(): () => void {
  unsubscribeSystemSync?.();
  const darkUnsubscribe = subscribeSystemDark(() => {
    if (readTheme() === "system") applyTheme("system");
  });
  const query = phoneThemeColorQuery();
  const onWidthChange = () => applyTheme(readTheme());
  query?.addEventListener("change", onWidthChange);
  const unsubscribe = () => {
    darkUnsubscribe();
    query?.removeEventListener("change", onWidthChange);
  };
  unsubscribeSystemSync = unsubscribe;
  return unsubscribe;
}
