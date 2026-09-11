import { HUB_COLOR, THEME_KEY } from "./device-theme.js";

/**
 * The literal source of the inline `<script>` `index.html` runs in its
 * `<head>`, before `main.tsx` or anything else loads (#287). Kept here as a
 * string, rather than authored only inside the HTML, for two reasons:
 *
 * - `device-theme.test.ts` can `new Function(PRE_PAINT_SCRIPT)()` it against
 *   a bare `document`/`localStorage`/`matchMedia`, with no bundle loaded at
 *   all — the issue's own acceptance criterion, and the only way to exercise
 *   this exact code path under test, since it never goes through Vite/React.
 * - `index.html` has to carry this exact text; a test here reads the file
 *   and asserts it, the same "keep them in step" guard the module's cold-load
 *   fallback tests already use for `HUB_COLOR`.
 *
 * Deliberately plain, old-style JS — `var`, no arrow functions, no optional
 * chaining — because it runs unbundled and untranspiled straight off the
 * wire, on whatever browser cold-loads the page, before any target/polyfill
 * from the build applies to it. It swallows every error itself (a blocked or
 * absent `localStorage`, no `matchMedia`, …) rather than ever risking first
 * paint on a preference read that a real device can simply refuse.
 *
 * Mirrors `applyTheme`/`applyThemeColor`'s own resolution (`device-theme.ts`)
 * exactly, but can't call them directly: nothing but this literal string
 * exists yet when it runs.
 */
export const PRE_PAINT_SCRIPT = `(function () {
  var stored, theme, dark, meta;
  try {
    stored = localStorage.getItem("${THEME_KEY}");
    theme = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.classList.toggle("dark", theme === "dark");
    meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", dark ? "${HUB_COLOR.dark}" : "${HUB_COLOR.light}");
  } catch (_e) {}
})();`;
