/**
 * Type: one sans face for running UI text, self-hosted from the instance's
 * own origin (no font CDN), plus a monospace face reserved for machine
 * values — timestamps, sizes, counts — set with tabular figures so a column
 * of them lines up.
 */
export interface FontTheme {
  sans: string;
  mono: string;
}

export const fonts: FontTheme = {
  sans: '"Inter Variable", "Helvetica Neue", Arial, sans-serif',
  mono: '"Martian Mono Variable", ui-monospace, "SFMono-Regular", Menlo, monospace',
};
