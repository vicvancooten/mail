/**
 * Type: one sans face for running UI text, self-hosted from the instance's
 * own origin (no font CDN). Machine values — timestamps, sizes, counts — set
 * in that same sans face with tabular figures so a column of them lines up;
 * `mono` is a system stack kept only for the one verbatim, code-like run
 * (the compose SMTP rejection text) that genuinely is code, not measurement
 * (polish pass, decision A: Martian Mono retired entirely).
 */
export interface FontTheme {
  sans: string;
  mono: string;
}

export const fonts: FontTheme = {
  sans: '"Inter Variable", "Helvetica Neue", Arial, sans-serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
};
