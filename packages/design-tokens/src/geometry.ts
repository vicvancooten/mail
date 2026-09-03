/**
 * Geometry: the comp's own radius ladder
 * (`docs/design/prototypes/the-instrument.html`, `--r-control`/`--r-panel`/
 * `--r-pill` plus the 10-11px it draws list rows at), and the one shadow in
 * the system, reserved for things that genuinely float above the ground
 * (popovers, dialogs, the composer) — nothing else casts one. Regions are
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
}

export const lightShadow: ShadowTheme = {
  overlay: "0 16px 40px -12px rgb(20 21 26 / 0.20), 0 4px 14px -4px rgb(20 21 26 / 0.12)",
};

export const darkShadow: ShadowTheme = {
  overlay: "0 22px 50px -14px rgb(0 0 0 / 0.6), 0 6px 16px -4px rgb(0 0 0 / 0.45)",
};
