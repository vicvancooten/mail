import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTheme, HUB_COLOR, readTheme, writeTheme } from "./device-theme.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Appearance is a Device Preference (#72), so the two things it has to move
 * are the root classes `index.css` styles off and the `<meta name="theme-color">`
 * pair the browser's own chrome reads. The second is the one a media query
 * cannot get right on its own — see `applyThemeColor`'s doc comment.
 */

const LIGHT = "#f5f5f8";
const DARK = "#08090b";

function seedMetaTags(): void {
  document.head.innerHTML = `
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="${LIGHT}">
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="${DARK}">
  `;
}

function themeColors(): string[] {
  return [...document.querySelectorAll('meta[name="theme-color"]')].map(
    (meta) => meta.getAttribute("content") ?? "",
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  seedMetaTags();
});

afterEach(() => {
  document.head.innerHTML = "";
  document.documentElement.className = "";
});

describe("applyTheme", () => {
  it("leaves the per-scheme pair alone for `system`, so the OS still decides", () => {
    applyTheme("system");
    expect(document.documentElement.className).toBe("");
    expect(themeColors()).toEqual([LIGHT, DARK]);
  });

  it("puts the chosen appearance on both tags, so the chrome matches the Hub on either OS", () => {
    // The reported bug: a User on a dark OS who picks `light` in the Hub got
    // the dark tag's near-black chrome above a light app, because a
    // `prefers-color-scheme` media query cannot see a `localStorage` choice.
    applyTheme("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(themeColors()).toEqual([LIGHT, LIGHT]);

    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(themeColors()).toEqual([DARK, DARK]);
  });

  it("restores the per-scheme pair when the User goes back to `system`", () => {
    applyTheme("dark");
    applyTheme("system");
    expect(themeColors()).toEqual([LIGHT, DARK]);
  });

  it("does nothing at all when the document carries no theme-color tags", () => {
    document.head.innerHTML = "";
    expect(() => applyTheme("dark")).not.toThrow();
  });
});

describe("writeTheme", () => {
  it("persists the choice and applies it in one call", () => {
    writeTheme("dark");
    expect(readTheme()).toBe("dark");
    expect(themeColors()).toEqual([DARK, DARK]);
  });
});

describe("cold-load fallbacks (#137)", () => {
  // `manifest.webmanifest`'s `theme_color` and `index.html`'s per-scheme
  // `<meta name="theme-color">` pair only ever paint before `applyTheme`
  // runs — the manifest at install/splash time, the meta pair before first
  // paint. Both are meant to be a *fallback* for `system`, never a second
  // source of truth, so both must stay pinned to `HUB_COLOR`; this guards
  // the "keep them in step" drift the module's own docstring warns about.
  it("keeps manifest.webmanifest's theme_color pinned to the light HUB_COLOR", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(HERE, "../../public/manifest.webmanifest"), "utf8"),
    ) as { theme_color: string };
    expect(manifest.theme_color).toBe(HUB_COLOR.light);
  });

  it("keeps index.html's cold-load meta pair pinned to HUB_COLOR", () => {
    const html = readFileSync(resolve(HERE, "../../index.html"), "utf8");
    expect(html).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${HUB_COLOR.light}" />`,
    );
    expect(html).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${HUB_COLOR.dark}" />`,
    );
  });
});
