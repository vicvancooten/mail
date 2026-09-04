import {
  type AvatarTileKey,
  type AvatarTileTheme,
  type ColorTheme,
  darkAvatarTiles,
  darkColors,
  lightAvatarTiles,
  lightColors,
} from "./colors.js";
import { darkShadow, hairline, lightShadow, radii, type ShadowTheme } from "./geometry.js";
import { fonts } from "./typography.js";

const colorVarName: Record<keyof ColorTheme, string> = {
  bg: "--color-bg",
  surface: "--color-surface",
  surfaceStrong: "--color-surface-strong",
  hover: "--color-hover",
  field: "--color-field",
  fieldStrong: "--color-field-strong",
  ink: "--color-ink",
  inkMuted: "--color-ink-muted",
  inkFaint: "--color-ink-faint",
  border: "--color-border",
  accent: "--color-accent",
  accentForeground: "--color-accent-foreground",
  accentSoft: "--color-accent-soft",
  danger: "--color-danger",
  warn: "--color-warn",
  success: "--color-success",
};

function colorDeclarations(theme: ColorTheme, indent: string): string {
  return (Object.keys(colorVarName) as (keyof ColorTheme)[])
    .map((key) => `${indent}${colorVarName[key]}: ${theme[key]};`)
    .join("\n");
}

const tileKeys: readonly AvatarTileKey[] = ["a", "b", "c", "d", "e"];

function tileDeclarations(theme: AvatarTileTheme, indent: string): string {
  return tileKeys
    .map(
      (key) =>
        `${indent}--tile-${key}-bg: ${theme[key].bg};\n${indent}--tile-${key}-ink: ${theme[key].ink};`,
    )
    .join("\n");
}

function shadowDeclarations(theme: ShadowTheme, indent: string): string {
  return `${indent}--shadow-overlay: ${theme.overlay};\n${indent}--shadow-header: ${theme.header};\n${indent}--shadow-card: ${theme.card};`;
}

/**
 * Emits the CSS that Tailwind's `@theme` consumes: colour tokens declared
 * once per theme, type/geometry/shadow tokens declared once since they do
 * not change between light and dark. Selector strategy matches the rest of
 * the Client's theming — an OS preference wins by default, guarded against
 * an explicit `.light`, and an explicit `.dark` wins outright — so wiring a
 * toggle to `documentElement.classList` is a drop-in, not a rewrite.
 */
export function buildTokensCss(): string {
  return `:root {
  color-scheme: light dark;
${colorDeclarations(lightColors, "  ")}
${tileDeclarations(lightAvatarTiles, "  ")}

  --font-sans: ${fonts.sans};
  --font-mono: ${fonts.mono};
  --radius-sm: ${radii.sm};
  --radius-md: ${radii.md};
  --radius-row: ${radii.row};
  --radius-panel: ${radii.panel};
  --radius-pill: ${radii.pill};
  --hairline: ${hairline};
${shadowDeclarations(lightShadow, "  ")}
}

@media (prefers-color-scheme: dark) {
  :root:not(.light) {
${colorDeclarations(darkColors, "    ")}
${tileDeclarations(darkAvatarTiles, "    ")}
${shadowDeclarations(darkShadow, "    ")}
  }
}

:root.dark {
  color-scheme: dark;
${colorDeclarations(darkColors, "  ")}
${tileDeclarations(darkAvatarTiles, "  ")}
${shadowDeclarations(darkShadow, "  ")}
}

:root.light {
  color-scheme: light;
}
`;
}
