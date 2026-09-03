/**
 * The Instrument's colour system: a near-white ground in light, a near-black
 * one in dark, and a single electric accent that carries every call to
 * action, focus ring and selection. Everything else is ink at three
 * strengths plus three semantic signals (danger/warn/success) — no per-
 * feature colours live here, so a new surface reaches for these same names
 * rather than inventing its own.
 */
export interface ColorTheme {
  /** The page ground. */
  bg: string;
  /** A raised surface on the ground: panels, rows, popovers before hover. */
  surface: string;
  /** A step further off the ground than `surface` — headers, sunk chrome. */
  surfaceStrong: string;
  /** A surface under pointer/keyboard interaction. */
  hover: string;
  /** A form control's fill. */
  field: string;
  /** A form control's fill once it holds focus or a value. */
  fieldStrong: string;
  /** Primary text. */
  ink: string;
  /** Secondary text: labels, metadata. */
  inkMuted: string;
  /** Tertiary text: placeholders, disabled, the quietest reading. */
  inkFaint: string;
  /** The 1px hairline that divides regions — never a shadow, never a card. */
  border: string;
  /** The one electric accent: primary actions, focus, selection. */
  accent: string;
  /** Text/icons placed on a solid `accent` fill. */
  accentForeground: string;
  /** A quiet tint of `accent`, for a control's "current" state. */
  accentSoft: string;
  /** Destructive actions and failure states. */
  danger: string;
  /** Held/attention states that are not failures. */
  warn: string;
  /** Confirmed/admitted states. */
  success: string;
}

export const lightColors: ColorTheme = {
  bg: "#fbfbfc",
  surface: "#ffffff",
  surfaceStrong: "#f5f5f8",
  hover: "#f1f1f4",
  field: "#f0f0f3",
  fieldStrong: "#e7e7ec",
  ink: "#14151a",
  inkMuted: "#5a5d6b",
  inkFaint: "#93969f",
  border: "#e3e4ea",
  accent: "#4338ca",
  accentForeground: "#ffffff",
  accentSoft: "#eeecfc",
  danger: "#c8402f",
  warn: "#b3790a",
  success: "#1a8f5c",
};

export const darkColors: ColorTheme = {
  bg: "#0c0d10",
  surface: "#101116",
  surfaceStrong: "#08090b",
  hover: "#17181e",
  field: "#16171d",
  fieldStrong: "#1e2027",
  ink: "#eef0f4",
  inkMuted: "#a4a8b5",
  inkFaint: "#6c7078",
  border: "#1e2027",
  accent: "#8b80ff",
  accentForeground: "#0c0d10",
  accentSoft: "#1c1a33",
  danger: "#ff6f61",
  warn: "#f2ab4c",
  success: "#35c98a",
};

/**
 * The avatar tile palette: five tinted fill/ink pairs a correspondent's
 * initials circle is drawn from, picked deterministically off the address so
 * the same correspondent keeps the same tile forever
 * (`apps/client/src/mail/Avatar.tsx`). Five rather than a full hue wheel
 * because a scanned list wants variety without noise — the comp's own
 * `.tile-a`…`.tile-e`.
 *
 * Separate from `ColorTheme` on purpose: these are not roles a new surface
 * reaches for by name, they are one closed set with one consumer.
 */
export interface AvatarTile {
  bg: string;
  ink: string;
}

export type AvatarTileKey = "a" | "b" | "c" | "d" | "e";

export type AvatarTileTheme = Record<AvatarTileKey, AvatarTile>;

export const lightAvatarTiles: AvatarTileTheme = {
  a: { bg: "#e4e1fb", ink: "#3730a3" },
  b: { bg: "#d9f2ec", ink: "#0f6656" },
  c: { bg: "#fdeccb", ink: "#8a5a06" },
  d: { bg: "#fbe0ea", ink: "#9d174d" },
  e: { bg: "#e2e8f4", ink: "#33415c" },
};

export const darkAvatarTiles: AvatarTileTheme = {
  a: { bg: "#2a2360", ink: "#c7c2ff" },
  b: { bg: "#113830", ink: "#7fe0c9" },
  c: { bg: "#3a2c08", ink: "#f0c27a" },
  d: { bg: "#3a1626", ink: "#f4a8c6" },
  e: { bg: "#1f2636", ink: "#a9b8d6" },
};
