import { describe, expect, it } from "vitest";
import { buildTokensCss } from "./css.js";

describe("buildTokensCss", () => {
  const css = buildTokensCss();

  it("declares the light colour tokens on :root", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf("@media"));
    expect(root).toContain("--color-bg: #fbfbfc;");
    expect(root).toContain("--color-accent: #4338ca;");
    expect(root).toContain("--color-accent-foreground: #ffffff;");
  });

  it("declares the type, geometry and shadow tokens on :root", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf("@media"));
    expect(root).toContain('--font-sans: "Inter Variable"');
    expect(root).toContain('--font-mono: "Martian Mono Variable"');
    expect(root).toContain("--radius-sm: 6px;");
    expect(root).toContain("--radius-md: 8px;");
    expect(root).toContain("--hairline: 1px;");
    expect(root).toContain("--shadow-overlay:");
  });

  it("overrides colours for an OS dark preference, guarded against an explicit .light", () => {
    const mediaBlock = css.slice(
      css.indexOf("@media (prefers-color-scheme: dark)"),
      css.indexOf(":root.dark"),
    );
    expect(mediaBlock).toContain(":root:not(.light) {");
    expect(mediaBlock).toContain("--color-bg: #0c0d10;");
    expect(mediaBlock).toContain("--color-accent: #8b80ff;");
  });

  it("overrides colours again for an explicit .dark class, so a toggle wins either way", () => {
    const darkClassBlock = css.slice(css.indexOf(":root.dark {"), css.indexOf(":root.light {"));
    expect(darkClassBlock).toContain("color-scheme: dark;");
    expect(darkClassBlock).toContain("--color-bg: #0c0d10;");
  });

  it("pins colour-scheme to light under an explicit .light class", () => {
    const lightClassBlock = css.slice(css.indexOf(":root.light {"));
    expect(lightClassBlock).toContain("color-scheme: light;");
  });

  it("does not repeat the type, geometry or shadow tokens in a theme override", () => {
    const overrides = css.slice(css.indexOf("@media"));
    expect(overrides).not.toContain("--font-sans");
    expect(overrides).not.toContain("--radius-sm");
  });
});
