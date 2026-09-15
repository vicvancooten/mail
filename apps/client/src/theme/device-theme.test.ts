import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubMatchMedia } from "../test-support/match-media.js";
import {
  applyTheme,
  HUB_COLOR,
  HUB_COLOR_PHONE,
  readTheme,
  syncThemeWithSystem,
  writeTheme,
} from "./device-theme.js";
import { PRE_PAINT_SCRIPT } from "./pre-paint.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Appearance is a Device Preference (#72), so the two things it has to move
 * are the root classes `index.css` styles off and the single
 * `<meta name="theme-color">` the browser's own chrome reads (#287). The
 * second is the one a media query cannot get right on its own — see
 * `applyThemeColor`'s doc comment.
 *
 * R1 (`docs/design/polish-pass.md`): that resolution is width-aware now
 * too, `HUB_COLOR` at ≥768px and `HUB_COLOR_PHONE` below it — every stub
 * below that isn't explicitly testing the phone pair pins `(max-width:
 * 767px)` to `false` (desktop), the same "OS scheme defaults to light
 * unless a test says otherwise" posture the existing dark-scheme stubs
 * already took, so a test written before this ticket keeps meaning what it
 * always meant.
 */

const LIGHT = HUB_COLOR.light;
const DARK = HUB_COLOR.dark;
const LIGHT_PHONE = HUB_COLOR_PHONE.light;
const DARK_PHONE = HUB_COLOR_PHONE.dark;
const PHONE_QUERY = "(max-width: 767px)";

function themeColorMetas(): string[] {
  return [...document.querySelectorAll('meta[name="theme-color"]')].map(
    (meta) => meta.getAttribute("content") ?? "",
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  document.head.innerHTML = "";
});

afterEach(() => {
  document.head.innerHTML = "";
  document.documentElement.className = "";
});

describe("applyTheme", () => {
  it("creates exactly one theme-color meta, with no media attribute, on a document with none", () => {
    applyTheme("light");
    const metas = document.querySelectorAll('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0]?.getAttribute("media")).toBeNull();
  });

  it("resolves `light` and `dark` to their own ground, regardless of the OS scheme", () => {
    // OS says dark throughout, desktop width throughout; light/dark must
    // ignore the OS scheme, and this stays desktop width so `LIGHT`/`DARK`
    // (not the phone pair) are the right expectation below.
    stubMatchMedia((query) => query !== PHONE_QUERY);

    applyTheme("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(themeColorMetas()).toEqual([LIGHT]);

    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(themeColorMetas()).toEqual([DARK]);
  });

  it("resolves to the phone ground below 768px, regardless of appearance", () => {
    stubMatchMedia((query) => query === PHONE_QUERY);

    applyTheme("light");
    expect(themeColorMetas()).toEqual([LIGHT_PHONE]);

    applyTheme("dark");
    expect(themeColorMetas()).toEqual([DARK_PHONE]);
  });

  it("resolves `system` against the current OS scheme, one meta either way", () => {
    const { setMatches } = stubMatchMedia(() => false);

    applyTheme("system");
    expect(document.documentElement.className).toBe("");
    expect(themeColorMetas()).toEqual([LIGHT]);

    setMatches("(prefers-color-scheme: dark)", true);
    applyTheme("system");
    expect(document.documentElement.className).toBe("");
    expect(themeColorMetas()).toEqual([DARK]);
  });

  it("reuses the existing tag rather than creating a second one", () => {
    applyTheme("light");
    applyTheme("dark");
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(themeColorMetas()).toEqual([DARK]);
  });

  it("does nothing when there is no document at all to touch", () => {
    expect(() => applyTheme("dark")).not.toThrow();
  });
});

describe("writeTheme", () => {
  it("persists the choice and applies it in one call", () => {
    writeTheme("dark");
    expect(readTheme()).toBe("dark");
    expect(themeColorMetas()).toEqual([DARK]);
  });
});

describe("syncThemeWithSystem (#287)", () => {
  it("moves the meta and document classes on an OS scheme change while stored theme is `system`, with no reload", () => {
    const { setMatches } = stubMatchMedia(() => false);
    writeTheme("system");
    expect(themeColorMetas()).toEqual([LIGHT]);

    const unsubscribe = syncThemeWithSystem();
    setMatches("(prefers-color-scheme: dark)", true);

    expect(themeColorMetas()).toEqual([DARK]);
    expect(document.documentElement.className).toBe("");
    unsubscribe();
  });

  it("leaves an explicit light/dark choice alone when the OS scheme changes", () => {
    const { setMatches } = stubMatchMedia(() => false);
    writeTheme("light");

    const unsubscribe = syncThemeWithSystem();
    setMatches("(prefers-color-scheme: dark)", true);

    expect(themeColorMetas()).toEqual([LIGHT]);
    unsubscribe();
  });

  it("replaces rather than stacks its subscription on a second call", () => {
    const { setMatches } = stubMatchMedia(() => false);
    writeTheme("system");

    syncThemeWithSystem();
    syncThemeWithSystem();
    setMatches("(prefers-color-scheme: dark)", true);

    // A stacked (rather than replaced) subscription would still only
    // resolve to one meta value, so this is really just guarding that two
    // calls don't throw or double up listeners in a way a later assertion
    // would ever start showing.
    expect(themeColorMetas()).toEqual([DARK]);
  });

  it("R1: moves the meta to the phone ground on a width change, with no reload", () => {
    const { setMatches } = stubMatchMedia(() => false);
    writeTheme("dark");
    expect(themeColorMetas()).toEqual([DARK]);

    const unsubscribe = syncThemeWithSystem();
    setMatches(PHONE_QUERY, true);

    expect(themeColorMetas()).toEqual([DARK_PHONE]);
    unsubscribe();
  });

  it("R1: a width change re-applies even an explicit light/dark choice — it isn't an OS scheme override", () => {
    const { setMatches } = stubMatchMedia(() => false);
    writeTheme("light");

    const unsubscribe = syncThemeWithSystem();
    setMatches(PHONE_QUERY, true);

    expect(themeColorMetas()).toEqual([LIGHT_PHONE]);
    unsubscribe();
  });
});

describe("the pre-paint script (#287)", () => {
  // Evaluated exactly as `index.html` runs it — against a bare document,
  // with no bundle loaded — per the issue's own acceptance criterion.
  function runPrePaint(): void {
    new Function(PRE_PAINT_SCRIPT)();
  }

  it("sets the theme class and the resolved meta from stored `light`/`dark`, with no *OS-scheme* read needed", () => {
    // R1: the script now always reads width (for `HUB_COLOR`/`HUB_COLOR_PHONE`),
    // even for an explicit `light`/`dark` choice that needs no OS-scheme
    // read — stubbed explicitly (not left to whatever a previous test's
    // `matchMedia` mock happens to still be, since nothing here unstubs
    // between tests) so this test's own desktop-width assumption never
    // silently rides on test order.
    stubMatchMedia((query) => query !== PHONE_QUERY);

    localStorage.setItem("device.theme", "light");
    runPrePaint();
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(themeColorMetas()).toEqual([LIGHT]);

    document.documentElement.className = "";
    document.head.innerHTML = "";
    localStorage.setItem("device.theme", "dark");
    runPrePaint();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(themeColorMetas()).toEqual([DARK]);
  });

  it("resolves stored `system` against the OS scheme, for either scheme", () => {
    const { setMatches } = stubMatchMedia(() => false);
    localStorage.setItem("device.theme", "system");

    runPrePaint();
    expect(document.documentElement.className).toBe("");
    expect(themeColorMetas()).toEqual([LIGHT]);

    document.head.innerHTML = "";
    setMatches("(prefers-color-scheme: dark)", true);
    runPrePaint();
    expect(document.documentElement.className).toBe("");
    expect(themeColorMetas()).toEqual([DARK]);
  });

  it("falls back to `system` with no stored preference at all", () => {
    stubMatchMedia(() => false);
    runPrePaint();
    expect(themeColorMetas()).toEqual([LIGHT]);
  });

  it("R1: resolves the phone ground below 768px, for either appearance", () => {
    stubMatchMedia((query) => query === PHONE_QUERY);
    localStorage.setItem("device.theme", "light");

    runPrePaint();
    expect(themeColorMetas()).toEqual([LIGHT_PHONE]);

    document.head.innerHTML = "";
    localStorage.setItem("device.theme", "dark");
    runPrePaint();
    expect(themeColorMetas()).toEqual([DARK_PHONE]);
  });

  it("never throws, even with no localStorage/matchMedia in the document at all", () => {
    expect(() => runPrePaint()).not.toThrow();
  });
});

describe("cold-load fallbacks (#137, #287)", () => {
  // `index.html`'s inline pre-paint script is the one thing that still
  // paints before `main.tsx` runs (the manifest's own `theme_color` is gone
  // — R1's Android step 2, this module's own doc comment on why), so this
  // is meant to stay pinned to `PRE_PAINT_SCRIPT`, never drift into a
  // second source of truth.
  it("keeps manifest.webmanifest free of theme_color, so an installed Android WebAPK follows the page's own meta instead", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(HERE, "../../public/manifest.webmanifest"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.theme_color).toBeUndefined();
    // `background_color` (the splash screen, painted before any script can
    // run at all) is unaffected — only `theme_color` (the status bar, which
    // the meta tag can update after the fact) is the problem this retires.
    expect(manifest.background_color).toBe(HUB_COLOR_PHONE.light);
  });

  it("keeps index.html's inline script pinned to PRE_PAINT_SCRIPT", () => {
    const html = readFileSync(resolve(HERE, "../../index.html"), "utf8");
    // Whitespace-normalized: index.html indents to fit its own nesting,
    // `PRE_PAINT_SCRIPT` doesn't, but the actual statements must match.
    const normalize = (source: string) => source.replace(/\s+/g, " ").trim();
    expect(normalize(html)).toContain(normalize(PRE_PAINT_SCRIPT));
  });
});
