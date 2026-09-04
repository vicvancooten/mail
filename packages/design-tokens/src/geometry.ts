/**
 * Geometry: the comp's own radius ladder
 * (`docs/design/prototypes/the-instrument.html`, `--r-control`/`--r-panel`/
 * `--r-pill` plus the 10-11px it draws list rows at), and the system's two
 * shadows: `overlay`, for things that genuinely float above the ground
 * (popovers, dialogs, the composer), and `header`, the app header's fixed
 * relief-from-the-ground recipe — nothing else casts either. Regions are
 * separated by ground and gap, not by joinery, so `hairline` survives only
 * for the few places a rule genuinely reads as structure.
 */
export const hairline = "1px";

export const radii = {
  /** Inline controls: a chip, a keycap, a swatch. */
  sm: "6px",
  /** The default control corner: buttons, inputs, icon buttons. */
  md: "8px",
  /** A list row or a menu item — the comp's own 10-11px row corner. */
  row: "11px",
  /** A floating panel: the Command Palette, a popover, the composer, a card. */
  panel: "16px",
  /** A pill: Compose, the global search entry, the primary Send. */
  pill: "999px",
} as const;

export interface ShadowTheme {
  /** The one shadow: popovers, dialogs, the overlay layer. */
  overlay: string;
  /** The app header's relief-from-the-ground treatment (inset highlight,
   * inset shade, and a hairline drop) — its own token because it is a fixed
   * three-layer recipe, not a floating-element shadow. */
  header: string;
  /** The App's raised-card elevation (#96): a page element that sits in
   * place on the Hub's ground rather than something that just opened over
   * everything, so it stays well short of `overlay` — the Split reading
   * pane, Stream cards and Screener previews all reuse this one. */
  card: string;
}

export const lightShadow: ShadowTheme = {
  overlay: "0 16px 40px -12px rgb(20 21 26 / 0.20), 0 4px 14px -4px rgb(20 21 26 / 0.12)",
  header:
    "inset 0 1px 0 rgb(255 255 255 / 0.5), inset 0 -1px 2px rgb(20 21 26 / 0.045), 0 1px 2px rgb(20 21 26 / 0.03)",
  card: "0 1px 2px rgb(20 21 26 / 0.05), 0 6px 20px -10px rgb(20 21 26 / 0.16)",
};

export const darkShadow: ShadowTheme = {
  overlay: "0 22px 50px -14px rgb(0 0 0 / 0.6), 0 6px 16px -4px rgb(0 0 0 / 0.45)",
  header:
    "inset 0 1px 0 rgb(255 255 255 / 0.03), inset 0 -1px 2px rgb(0 0 0 / 0.35), 0 1px 2px rgb(0 0 0 / 0.2)",
  card: "0 1px 2px rgb(0 0 0 / 0.3), 0 8px 24px -12px rgb(0 0 0 / 0.5)",
};
