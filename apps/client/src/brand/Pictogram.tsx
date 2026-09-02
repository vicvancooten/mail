/**
 * Wicket's pictogram set.
 *
 * Signage pictograms are solid and heavy so they survive being small, dirty
 * and far away — the opposite of a hairline icon library. The whole set is
 * drawn on one 24 grid with filled shapes and no strokes, so nothing in the
 * app ever puts a 2px outline glyph next to a solid one.
 *
 * These are authored rather than imported because the vocabulary is the
 * point: a tray rather than a downward arrow for Archive, a grommet rather
 * than a pushpin for Pin, a barred disc for Block. Nothing the app itself
 * renders comes from an icon library any more.
 *
 * `lucide-react` remains a dependency only because the shadcn primitives in
 * `components/ui/` embed it (Select's chevron, Dialog's close, DropdownMenu's
 * check). Those primitives are installed and themed but not yet adopted by
 * any screen; the first screen that adopts one should swap its internal glyph
 * for the matching name here, so the app never puts a hairline outline icon
 * beside one of these solid ones.
 */

export type PictogramName =
  // triage
  | "archive"
  | "trash"
  | "star"
  | "pin"
  | "label"
  | "snooze"
  // gatekeeper
  | "held"
  | "admit"
  | "block"
  // correspondence
  | "reply"
  | "reply-all"
  | "forward"
  | "compose"
  | "send"
  | "attach"
  | "file"
  // navigation and chrome
  | "search"
  | "frame"
  | "account"
  | "chevron-right"
  | "close"
  | "check"
  | "undo"
  | "retry"
  | "expand"
  | "collapse"
  | "warning"
  | "shield"
  | "arrow-left"
  | "arrow-right"
  | "arrow-up"
  | "arrow-down"
  | "chevron-left"
  | "opened"
  // view modes
  | "split"
  | "rows"
  | "stream"
  // editor
  | "heading"
  | "heading-1"
  | "heading-3"
  | "list"
  | "list-ordered"
  | "list-checks"
  | "quote"
  | "pen"
  | "pen-square"
  | "align-left"
  | "align-center"
  | "align-right"
  | "rule"
  | "table"
  | "link"
  | "palette"
  | "highlight"
  | "code"
  // letterforms, set in the brand face rather than drawn as icons
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough";

/** The type-formatting controls act on type, so they are set in type. */
const LETTERS: Partial<
  Record<
    PictogramName,
    { glyph: string; weight: number; italic?: boolean; bar?: "under" | "through" }
  >
> = {
  bold: { glyph: "B", weight: 900 },
  italic: { glyph: "I", weight: 500, italic: true },
  underline: { glyph: "U", weight: 700, bar: "under" },
  strikethrough: { glyph: "S", weight: 700, bar: "through" },
};

const PATHS: Record<PictogramName, string> = {
  // --- triage -------------------------------------------------------------
  // a sorting tray: lid, body, and the hand slot cut in its face
  archive: "M2 4h20v4H2zM4 9.5h16V21H4zm4 3v2.4h8V12.5z",
  // the bin an item is returned to
  trash: "M9 2h6l1 2h5v3H3V4h5zM5 8.5h14L17.6 22H6.4z",
  star: "M12 2l3 7h7l-5.6 4.4L18.6 21 12 16.6 5.4 21l2.2-7.6L2 9h7z",
  // a brass grommet punched through the item
  pin: "M12 2a4 4 0 0 1 1.6 7.67L14.8 22H9.2l1.2-12.33A4 4 0 0 1 12 2zm0 3a1.4 1.4 0 1 0 0 2.8A1.4 1.4 0 0 0 12 5z",
  // a bundle band with its printed slot
  label: "M2 7h13l7 5-7 5H2zM5 10.4v3.2h8v-3.2z",
  // a held slip with its hour marked
  snooze: "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm1.4 4h-2.8v7.2l5.5 3.3 1.4-2.4-4.1-2.4z",

  // --- gatekeeper ---------------------------------------------------------
  // the screening hold: an hourglass, mail waiting on a verdict
  held: "M5 3h14v6.5a7 7 0 0 1-14 0zM5 21h14v-6.5a7 7 0 0 0-14 0z",
  // through the wicket
  admit: "M3 10h11V4l8 8-8 8v-6H3z",
  // barred: returned for good
  block:
    "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 3.4a6.6 6.6 0 0 0-4.2 1.5l9.3 9.3A6.6 6.6 0 0 0 12 5.4zm-6.1 3.4a6.6 6.6 0 0 0 9.3 9.3z",

  // --- correspondence -----------------------------------------------------
  reply: "M10 3v4.6C4.9 8.5 2 12.4 2 18v3l2.3-2.3A9 9 0 0 1 10 16.2V21l9-9z",
  "reply-all":
    "M8 3v4.6C3.6 8.6 1 12.4 1 18v3l2.2-2.3A8.6 8.6 0 0 1 8 16.2V21l8.6-9zM17.4 4.6 23 12l-5.6 7.4v-4.2L14.2 12l3.2-3.2z",
  forward: "M14 3v4.6c5.1.9 8 4.8 8 10.4v3l-2.3-2.3A9 9 0 0 0 14 16.2V21L5 12z",
  compose: "M2 4h20v3.2L12 14 2 7.2zM2 10.3l10 6.8 10-6.8V20H2z",
  // dispatched
  send: "M1.5 20.5 22.5 12 1.5 3.5v5.9l13 2.6-13 2.6z",
  attach:
    "M15.8 2.6a5 5 0 0 1 7 7L13 19.5a3.4 3.4 0 0 1-4.8-4.8l8.4-8.4 2 2-8.4 8.4a.6.6 0 0 0 .8.8l9.8-9.9a2.2 2.2 0 0 0-3.1-3.1L5.6 15.4a5.7 5.7 0 0 0 8 8l6-6 2 2-6 6a8.5 8.5 0 0 1-12-12z",
  file: "M4 2h9l7 7v13H4zm9.6 1.8V8.6h4.8z",

  // --- navigation and chrome ---------------------------------------------
  search:
    "M10 2a8 8 0 0 1 6.3 12.9l5.4 5.4-2.4 2.4-5.4-5.4A8 8 0 1 1 10 2zm0 3.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6z",
  // the sorting frame: compartments
  frame: "M3 3h8v7H3zm10 0h8v7h-8zM3 12h8v9H3zm10 0h8v9h-8z",
  account:
    "M12 2.5a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6zM2.5 22c0-4.7 4.3-8 9.5-8s9.5 3.3 9.5 8z",
  "chevron-right": "M8.6 3.4 17.2 12l-8.6 8.6-2.4-2.4L12.4 12 6.2 5.8z",
  close:
    "M18.7 3.9 12 10.6 5.3 3.9 3.9 5.3 10.6 12l-6.7 6.7 1.4 1.4 6.7-6.7 6.7 6.7 1.4-1.4-6.7-6.7 6.7-6.7z",
  check: "M9.2 19.4 1.6 11.8l2.8-2.8 4.8 4.8L19.6 3.4l2.8 2.8z",
  undo: "M9 5 2 11l7 6v-4h5.5A4.5 4.5 0 0 1 19 17.5V19h3v-1.5A7.5 7.5 0 0 0 14.5 10H9z",
  retry: "M4 4v5.5h5.5L7.4 7.4A7 7 0 1 1 5 12.5H2A10 10 0 1 0 9.6 5.2L7.5 4z",
  expand: "M14 3h7v7h-3V8.1l-4.6 4.6-2.1-2.1L15.9 6H14zM3 14h3v1.9l4.6-4.6 2.1 2.1L8.1 18H10v3H3z",
  collapse: "M21 4.1 16.1 9H18v3h-7V5h3v1.9L18.9 2zM6 12v3H3v-3H1.1L6 7.1 10.9 12H9v7H6z",
  warning: "M12 2.5 23 21H1zm-1 7v6h2v-6zm0 7.5v2.2h2V17z",
  shield: "M12 1.5 21 5v6.5c0 5.2-3.6 9.6-9 11-5.4-1.4-9-5.8-9-11V5zm-1 5v7h2v-7zm0 8.5v2.2h2V15z",

  // --- editor -------------------------------------------------------------
  heading:
    "M2 4h3.2v6.2h6.4V4h3.2v16h-3.2v-6.6H5.2V20H2zm15.4 5.4h4.8v2.2l-2.6 3h2.6V20h-4.8v-2.4h2.4L17.4 15z",
  list: "M2 5h3v3H2zm5 0h15v3H7zM2 10.5h3v3H2zm5 0h15v3H7zM2 16h3v3H2zm5 0h15v3H7z",
  "list-ordered":
    "M2 4h2.4v4.2H2.9V5.2H2zM7 5h15v3H7zM2 10.5h3.4v1.3L3.7 13.5h1.7v1.3H2v-1.3l1.7-1.7H2zM7 10.5h15v3H7zM2 16.4h3.4v1.2l-.9.7.9.7v1.2H2v-1.2h1.9l-.9-.7v-.5h.9V17H2zM7 16h15v3H7z",
  quote:
    "M3 6h7.4v6.6c0 3.4-2.3 5.6-5.7 6.4l-.9-2.2c2-.5 3-1.6 3.1-3.1H3zM13.6 6H21v6.6c0 3.4-2.3 5.6-5.7 6.4l-.9-2.2c2-.5 3-1.6 3.1-3.1h-3.9z",
  pen: "M3 17.2 14.6 5.6l3.8 3.8L6.8 21H3zm13.4-13.4 1.4-1.4a1.9 1.9 0 0 1 2.7 0l1.1 1.1a1.9 1.9 0 0 1 0 2.7l-1.4 1.4z",

  "arrow-left": "M10 3 1.5 12 10 21v-5.5h12v-7H10z",
  "arrow-right": "M14 3l8.5 9L14 21v-5.5H2v-7h12z",
  "arrow-up": "M12 1.5 3 10h5.5v12h7V10H21z",
  "arrow-down": "M12 22.5 3 14h5.5V2h7v12H21z",
  "chevron-left": "M15.4 3.4 6.8 12l8.6 8.6 2.4-2.4L11.6 12l6.2-6.2z",
  // an opened item: the flap is down
  opened: "M12 2.5 22 9.5V22H2V9.5zM4.6 10.8 12 15.6l7.4-4.8L12 5.9z",

  // --- view modes: the frame arranged three ways ---------------------------
  split: "M2 4h9v16H2zm11 0h9v16h-9z",
  rows: "M2 4h20v4.6H2zm0 5.7h20v4.6H2zm0 5.7h20V20H2z",
  stream:
    "M12 2 22.5 7.5 12 13 1.5 7.5zM3.9 11.4 12 15.6l8.1-4.2 2.4 1.2L12 18.2 1.5 12.6zm0 4.8L12 20.4l8.1-4.2 2.4 1.2L12 23 1.5 17.4z",

  // --- editor --------------------------------------------------------------
  "heading-1":
    "M2 4h3.2v6.2h6.4V4h3.2v16h-3.2v-6.6H5.2V20H2zm18.6 5.4V20h-2.9v-7.8h-2v-1.6c1.6-.1 2.5-.5 2.9-1.2z",
  "heading-3":
    "M2 4h3.2v6.2h6.4V4h3.2v16h-3.2v-6.6H5.2V20H2zm16 5.2c2.3 0 3.9 1.2 3.9 2.9 0 1-.6 1.8-1.5 2.2 1.1.4 1.8 1.3 1.8 2.5 0 1.9-1.7 3.2-4.2 3.2-1.5 0-2.8-.4-3.7-1.2l1.2-1.9c.6.5 1.4.8 2.3.8 1 0 1.7-.5 1.7-1.2s-.6-1.1-1.7-1.1h-1v-2h.9c.9 0 1.5-.4 1.5-1.1s-.5-1-1.4-1c-.8 0-1.5.3-2.1.8l-1.2-1.8c1-.7 2.2-1.1 3.5-1.1z",
  "list-checks":
    "M8.6 4.3 4.1 8.8 1.6 6.3 3 4.9l1.1 1.1 3.1-3.1zM11 5h11v3H11zM8.6 15.3l-4.5 4.5-2.5-2.5L3 15.9l1.1 1.1 3.1-3.1zM11 16h11v3H11z",
  "pen-square": "M3 3h11.5l-3 3H6v12h12v-5.6l3-3V21H3zm14.6-1.3 3.7 3.7-8.4 8.4H9.2V10.1z",
  "align-left": "M2 4h20v3H2zm0 5h13v3H2zm0 5h20v3H2zm0 5h13v3H2z",
  "align-center": "M2 4h20v3H2zm3.5 5h13v3h-13zM2 14h20v3H2zm3.5 5h13v3h-13z",
  "align-right": "M2 4h20v3H2zm7 5h13v3H9zM2 14h20v3H2zm7 5h13v3H9z",
  rule: "M2 10.5h20v3H2z",
  table: "M2 3h20v4H2zM2 8.5h9v5H2zm11 0h9v5h-9zM2 15h9v6H2zm11 0h9v6h-9z",
  link: "M8.5 7H11v2.4H8.5a2.6 2.6 0 0 0 0 5.2H11V17H8.5a5 5 0 0 1 0-10zm4.5 0h2.5a5 5 0 0 1 0 10H13v-2.4h2.5a2.6 2.6 0 0 0 0-5.2H13zm-5 3.8h7v2.4h-7z",
  palette:
    "M12 2a10 10 0 1 0 3 19.6c1-.3 1.4-1.5.8-2.4a2.6 2.6 0 0 1 2.2-4.1h1.3A2.7 2.7 0 0 0 22 12.4 10 10 0 0 0 12 2z",
  highlight: "M14.6 2.6 21.4 9.4l-8.6 8.6H9.3l-1.9 1.9H4.1v-3.3l1.9-1.9V11zM3 21h18v2H3z",
  code: "M8.6 4.4 10.8 6.6 5.4 12l5.4 5.4-2.2 2.2L1 12zm6.8 0L23 12l-7.6 7.6-2.2-2.2L18.6 12l-5.4-5.4z",

  // Letterforms are rendered from LETTERS, not from a path.
  bold: "",
  italic: "",
  underline: "",
  strikethrough: "",
};

export function Pictogram({
  name,
  size = 16,
  title,
  className,
}: {
  name: PictogramName;
  size?: number;
  /** Given: the glyph is an image with this label. Omitted: it is decorative. */
  title?: string;
  className?: string;
}) {
  const letter = LETTERS[name];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {letter ? (
        <>
          <text
            x="12"
            y={letter.bar === "under" ? 16.5 : 17.5}
            textAnchor="middle"
            fill="currentColor"
            fontFamily="var(--w-sans)"
            fontSize="19"
            fontWeight={letter.weight}
            fontStyle={letter.italic ? "italic" : undefined}
          >
            {letter.glyph}
          </text>
          {letter.bar === "under" ? (
            <rect x="5" y="19" width="14" height="2.4" fill="currentColor" />
          ) : null}
          {letter.bar === "through" ? (
            <rect x="4" y="10.8" width="16" height="2.4" fill="currentColor" />
          ) : null}
        </>
      ) : (
        <path d={PATHS[name]} fill="currentColor" />
      )}
    </svg>
  );
}
