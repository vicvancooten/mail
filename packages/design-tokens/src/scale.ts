/**
 * The one scale (R4, `docs/design/polish-pass.md`): before this, font sizes
 * and paddings across the Client's Apps were picked ad hoc — 14 distinct
 * font sizes, 13 distinct paddings, no two Apps agreeing. These three
 * ladders are the whole vocabulary now; any other value in `apps/client`
 * CSS is a defect unless `mail/taper.ts` owns it (the comp's own row/header
 * geometry, exempted because it predates and defines the scale rather than
 * consuming it).
 */

/**
 * Space ladder: 4, 8, 12, 16, 20, 24, 32 — every gap, padding and margin in
 * the Client snaps to one of these seven values.
 */
export const space = {
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  7: "32px",
} as const;

/**
 * Text ladder: five sizes, one per rank. `label` is the smallest legible
 * caption tier (filter chips, keycaps); `secondary` is muted supporting
 * text; `body` is the running UI voice; `title` is a pane header (Tasks,
 * Contacts, Notes, Calendar, Settings); `heading` is reserved for the
 * Reader's subject, the one heading in the app.
 */
export const text = {
  label: "11.5px",
  secondary: "13px",
  body: "14px",
  title: "17px",
  heading: "21px",
} as const;

/**
 * Control height ladder: `sm` is an inline icon control (a row's hover
 * action, a chip's remove button); `md` is the default toolbar control;
 * `primary` is the one solid-accent action per App; `touch` is the phone
 * dock's tap target, sized to the platform's minimum.
 */
export const controlHeight = {
  sm: "28px",
  md: "32px",
  primary: "38px",
  touch: "44px",
} as const;
