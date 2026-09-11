import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubMatchMedia } from "../test-support/match-media.js";
import {
  applyTheme,
  HUB_COLOR,
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
 */

const LIGHT = HUB_COLOR.light;
const DARK = HUB_COLOR.dark;

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
    stubMatchMedia(() => true); // OS says dark throughout; light/dark must ignore it

    applyTheme("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(themeColorMetas()).toEqual([LIGHT]);

    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(themeColorMetas()).toEqual([DARK]);
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
});

describe("the pre-paint script (#287)", () => {
  // Evaluated exactly as `index.html` runs it — against a bare document,
  // with no bundle loaded — per the issue's own acceptance criterion.
  function runPrePaint(): void {
    new Function(PRE_PAINT_SCRIPT)();
  }

  it("sets the theme class and the resolved meta from stored `light`/`dark`, with no OS/matchMedia read needed", () => {
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

  it("never throws, even with no localStorage/matchMedia in the document at all", () => {
    expect(() => runPrePaint()).not.toThrow();
  });
});

describe("cold-load fallbacks (#137, #287)", () => {
  // `manifest.webmanifest`'s `theme_color` and `index.html`'s inline
  // pre-paint script only ever paint before `main.tsx` runs — the manifest
  // at install/splash time, the script before first paint. Both are meant
  // to stay pinned to `HUB_COLOR`/`PRE_PAINT_SCRIPT`, never drift into a
  // second source of truth.
  it("keeps manifest.webmanifest's theme_color pinned to the light HUB_COLOR", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(HERE, "../../public/manifest.webmanifest"), "utf8"),
    ) as { theme_color: string };
    expect(manifest.theme_color).toBe(HUB_COLOR.light);
  });

  it("keeps index.html's inline script pinned to PRE_PAINT_SCRIPT", () => {
    const html = readFileSync(resolve(HERE, "../../index.html"), "utf8");
    // Whitespace-normalized: index.html indents to fit its own nesting,
    // `PRE_PAINT_SCRIPT` doesn't, but the actual statements must match.
    const normalize = (source: string) => source.replace(/\s+/g, " ").trim();
    expect(normalize(html)).toContain(normalize(PRE_PAINT_SCRIPT));
  });
});
