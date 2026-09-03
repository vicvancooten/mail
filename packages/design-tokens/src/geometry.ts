/**
 * Geometry: rules divide regions, corners stay tight, and the one shadow in
 * the system is reserved for things that genuinely float above the ground
 * (popovers, dialogs) — nothing else casts one.
 */
export const hairline = "1px";

export const radii = {
  /** Inline controls: a pill toggle's inner slice, small chips. */
  sm: "6px",
  /** The default: buttons, inputs, panels, the overlay layer. */
  md: "8px",
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
