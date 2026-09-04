---
name: The Instrument
description: A calm, ground-and-gap mail instrument — one electric accent, tonal surfaces, no hairlines, no plates.
colors:
  bg: "#fbfbfc"
  surface: "#ffffff"
  surface-strong: "#f5f5f8"
  hover: "#f1f1f4"
  field: "#f0f0f3"
  field-strong: "#e7e7ec"
  ink: "#14151a"
  ink-muted: "#5a5d6b"
  ink-faint: "#93969f"
  border: "#e3e4ea"
  accent: "#4338ca"
  accent-foreground: "#ffffff"
  accent-soft: "#eeecfc"
  danger: "#c8402f"
  warn: "#b3790a"
  success: "#1a8f5c"
  tile-a-bg: "#e4e1fb"
  tile-a-ink: "#3730a3"
  tile-b-bg: "#d9f2ec"
  tile-b-ink: "#0f6656"
  tile-c-bg: "#fdeccb"
  tile-c-ink: "#8a5a06"
  tile-d-bg: "#fbe0ea"
  tile-d-ink: "#9d174d"
  tile-e-bg: "#e2e8f4"
  tile-e-ink: "#33415c"
typography:
  heading:
    fontFamily: "Inter Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "21px"
    fontWeight: 650
    lineHeight: 1.28
    letterSpacing: "-0.017em"
  body:
    fontFamily: "Inter Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  secondary:
    fontFamily: "Inter Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Inter Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "11.5px"
    fontWeight: 600
    letterSpacing: "normal"
    fontVariation: "none — sentence case, never uppercase"
  machine:
    fontFamily: "Martian Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 500
    fontFeature: "tabular-nums"
rounded:
  sm: "6px"
  md: "8px"
  row: "11px"
  panel: "16px"
  pill: "999px"
spacing:
  header-height: "60px"
  header-pad-x: "20px"
  gutter: "16px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.md}"
  button-ghost-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  button-ghost-current:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  input-field:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  row-thread:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.row}"
    padding: "0 8px"
  row-thread-hover:
    backgroundColor: "{colors.hover}"
  row-thread-selected:
    backgroundColor: "{colors.accent-soft}"
  chip-tag:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  panel-floating:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
  toast:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "10px 14px"
---

# Design System: The Instrument

## Overview

**Creative North Star: "The Instrument"**

The Instrument is a near-white (or near-black) ground with exactly one electric accent
(`#4338ca` light / `#8b80ff` dark) doing every job that matters: primary actions, focus,
selection, current-state. Nothing else in the palette is decorative — three ink strengths
carry all text, three semantic signals (danger/warn/success) carry all state, and five
tinted "tile" pairs give correspondent initials just enough variety to scan without noise.
There is no second accent and no per-feature color.

Regions are separated by **ground and gap**, never by joinery. A list row, a menu item, a
settings compartment — none of them sit inside a hairline box or a bordered plate. The one
shadow in the system (`--shadow-overlay`) is reserved for things that genuinely float above
the ground: the Command Palette, popovers, the composer, toasts. Everything else is flat,
and rank between things at rest is expressed by a soft accent tint, not by inverting to
solid ink and not by a colored badge bolted onto the side of a row.

This replaces an older system ("Wicket / The Sorting Office" — institutional stock,
hairline joinery, struck ink, uppercase letterspaced "plates" for every label) which is
fully retired from the Mail surface, the chrome, and the App Switcher. See
[Named Rules](#named-rules) below for where its vocabulary still needs to be finished off.

**Key Characteristics:**
- One electric accent, everywhere rank or action needs marking; nothing else is decorative.
- Ground and gap, not joinery: no hairline box around a control, no plate behind a row.
- Rank is a soft accent tint (`--color-accent-soft`) at rest, `--color-hover` under the
  pointer — nothing inverts to solid ink.
- Corners come from one ladder: control → row → panel → pill, never an ad hoc radius.
- Actions live in reserved whitespace, revealed on hover/focus rather than inserted, so
  arming a control never reflows its neighbors.
- Type carries rank by size and weight. Labels are sentence case, small, and quiet —
  **never uppercase, never letterspaced.**
- The document itself never scrolls: the shell owns the viewport, every routed pane scrolls
  on its own.

## Colors

A near-white ground in light, a near-black one in dark, one electric accent that carries
every call to action, focus ring and selection, plus ink at three strengths and three
semantic signals. No per-feature colors: a new surface reaches for these same names.

### Primary
- **Accent** (`{colors.accent}`, `#4338ca` light / `#8b80ff` dark): the one electric color
  in the system — primary buttons (Compose, Send, Approve), the focus ring, text selection,
  the caret, the current nav tab/segment, a selected thread's tint, the unread dot. In dark
  it lifts to a lighter violet so it still reads as *the* accent against a near-black ground
  rather than needing extra contrast tricks.
- **Accent Soft** (`{colors.accent-soft}`): the quiet tint behind anything "current" — a
  selected thread row, the active nav tab, the App Switcher's badge. This, not solid ink, is
  how rank is shown at rest.

### Tertiary
- **Danger** (`{colors.danger}`): destructive actions and failure states (Block, delete,
  a failed send, error banners).
- **Warn** (`{colors.warn}`): held/attention states that are not failures.
- **Success** (`{colors.success}`): confirmed/admitted states (Approve, a completed send).

### Neutral
- **Bg** (`{colors.bg}`): the page ground. Body background.
- **Surface** (`{colors.surface}`): a raised surface on the ground — panels, popovers,
  the composer, before hover.
- **Surface Strong** (`{colors.surface-strong}`): a step further off the ground — the
  global header, the app-placeholder ground.
- **Hover** (`{colors.hover}`): any surface under pointer/keyboard interaction.
- **Field** / **Field Strong** (`{colors.field}` / `{colors.field-strong}`): a form
  control's fill at rest and once it holds focus or a value.
- **Ink** / **Ink Muted** / **Ink Faint** (`{colors.ink}` / `{colors.ink-muted}` /
  `{colors.ink-faint}`): primary text, secondary text (labels, metadata, a read row's
  sender/subject), and the quietest reading (placeholders, snippets, timestamps).
- **Border** (`{colors.border}`): the one hairline that still exists — dividing rows in a
  bordered list context (Settings, Screener cards), never used to box in a Mail row.

### The avatar tile palette
Five tinted fill/ink pairs (`{colors.tile-a-bg}`…`{colors.tile-e-bg}`) a correspondent's
initials circle is drawn from, picked deterministically off their address
(`mail/Avatar.tsx`) so the same correspondent keeps the same tile forever. A closed set of
five, not a hue wheel: a scanned list wants variety without noise.

### Named Rules
**The One Accent Rule.** `{colors.accent}` is the only color that means "this is the
primary action or the current thing." A new state does not get a new color; it gets a tint
of accent, one of the three semantic signals, or nothing.

**The Tint-Not-Invert Rule.** Rank at rest is `{colors.accent-soft}` with accent ink, never
`{colors.ink}` as a solid ground. The old system's "the selected row takes the ink and turns
inside out" is retired everywhere the rebuild has touched.

## Typography

**Body/Display Font:** Inter Variable (with Helvetica Neue, Arial, sans-serif), self-hosted
from the app's own origin — a client whose promise is that you own your server has no
business fetching fonts from a CDN on cold start.
**Machine Font:** Martian Mono Variable (with ui-monospace, SFMono-Regular, Menlo, monospace),
reserved for anything a machine measured: timestamps, byte sizes, counts. Tabular figures are
on for `time` and `.tabular`.

### Hierarchy
- **Heading** (650, 21px, -0.017em, `text-wrap: balance`): the open Thread's subject —
  the loudest text in the app, and the only place that size appears.
- **Body** (400, 14px, 1.5): a thread row's subject/sender, message content, running UI text.
- **Secondary** (400, 13px): meta lines, the reading pane's correspondent line, snippets.
- **Label** (600, 11–11.5px, sentence case): section labels, group-header names, the command
  palette's section captions. Small and quiet, never uppercase and never letterspaced.
- **Machine** (Martian Mono, 10–11px, tabular): timestamps, group counts, byte sizes, key caps.

### Named Rules
**The Sentence-Case Rule.** Every label, heading, and caption in the rebuilt system is
sentence case. `text-transform: uppercase` plus 0.10em+ tracking was the old system's
signature "Label" voice and does not belong here — see [Superseded Vocabulary](#superseded-vocabulary-still-to-finish)
for where it still lingers.

## Layout

**The bounded-pane rule (standing policy).** `.app-shell` is `100dvh` with `overflow:
hidden` — never `min-height` or `100vh` — so the document itself never scrolls, at any
width. Whichever route is current (Mail, Settings, or a placeholder App —
`router/routes.tsx`) renders into `.app-viewport`, and that route's own top-level element is
itself `height: 100%; min-height: 0` and scrolls independently. This is a hard rule, not a
convention: a new routed screen that grows past its own bounds without this pattern
regresses the two phone layout bugs #71 fixed (the virtualized Thread list needing a bounded
ancestor, and Settings being unreachable below the fold). Any new top-level route must
follow it.

The global header is a fixed 60px, three-column grid (`minmax(0,1fr) auto minmax(0,1fr)`) —
the App Switcher on the left, one centered search entry, appearance + avatar on the right —
so the search field centers on the *viewport*, not on whatever space is left beside the
switcher.

**Row geometry is load-bearing and tapered, not flat.** The thread list ranks
reverse-chronologically by *scale*, not just position: four tiers taper from 54px
(Pinned/Today) down to 32px (Older/Undated), with header heights tapering 26px → 20px plus a
26px lead. These values live once in `mail/taper.ts` and are consumed both as
`VirtualizedThreadList`'s `estimateSize` and as the row's own inline height — change them in
one place or the virtualizer and the rendered box disagree. `compact` density shifts every
tier by a fixed delta (-6px rows, -8px headers) rather than flattening the taper to one size.

**Responsive.** Below 700px: the list/detail split collapses to one pane at a time (both
stay mounted, one hidden), the permanent folder rail becomes a bottom sheet behind
`.side-nav-toggle`, and the header's row of view controls goes icon-only. `env(safe-area-
inset-*)` is added unconditionally to every edge-touching pad.

### Named Rules
**The Bounded Pane Rule.** `.app-shell` is `100dvh` + `overflow: hidden`; every routed pane
is its own `height: 100%; min-height: 0` scroller. No exceptions — this is how the phone
layout bugs stay fixed.

**The Ground-and-Gap Rule.** Regions separate by background-color change and whitespace, not
by a hairline box or a card. A control that needs a boundary gets `{rounded.md}` and
`{colors.field}`, not a 1px border around a `{colors.surface}` box.

## Elevation & Depth

Mostly flat: depth is tonal (`bg` → `surface` → `surface-strong` → `hover`/`accent-soft`),
and rank is a soft accent tint. There is exactly **one** shadow token
(`--shadow-overlay`), for things that genuinely float above the ground.

### Shadow Vocabulary
- **Overlay** (`box-shadow: var(--shadow-overlay)` = `0 16px 40px -12px rgb(20 21 26/.20),
  0 4px 14px -4px rgb(20 21 26/.12)`; dark: `0 22px 50px -14px rgb(0 0 0/.6), 0 6px 16px
  -4px rgb(0 0 0/.45)`): the Command Palette, the Shortcut Sheet, the composer, popovers,
  toasts.
- The global header's separation from the ground is `--shadow-header`, an inset relief
  (`inset 0 1px 0 white/.5, inset 0 -1px 2px ink/.045, 0 1px 2px ink/.03`) rather than a
  drop shadow — the one shadow-like treatment that isn't the overlay token, because the
  header never floats *above* anything, it sits at the top of the same ground.

### Named Rules
**The One Float Rule.** If it's part of the frame at rest, it has no shadow. If it floats
over the frame (Palette, popover, composer, toast), it takes `--shadow-overlay` — the same
value, never a softer or harder variant.

## Shapes

One radius ladder, walked by every surface: `{rounded.sm}` (6px, inline chips), `{rounded.md}`
(8px, the default control corner — buttons, inputs, icon buttons), `{rounded.row}` (11px, a
list row or menu item — the comp's own row corner), `{rounded.panel}` (16px, anything that
floats: the Command Palette, a popover, the composer), `{rounded.pill}` (999px, Compose, the
global search entry, primary Send/Approve buttons). Every Tailwind radius step from `md` up
maps onto this same ladder, so a `rounded-2xl` utility cannot smuggle in an off-ladder corner.

The correspondent mark is a **circle**, filled from the tile palette, carrying initials drawn
from the address — never a fetched image, since remote images stay blocked until a sender is
Approved.

Icons are a single Lucide stroke set at 1.6px weight (set once in `index.css`, not per call
site) — the hand-authored solid pictogram set from the old system is gone. The postmark mark
(`brand/Mark.tsx`) is the one drawn signature glyph that survives, on the same 24 grid as
every Lucide icon so weights line up; it appears as a solid mark at the pre-auth card and as
a stroked cut inside the App Switcher's hub mark.

## Components

### Buttons
- **Shape:** `{rounded.pill}` for primary actions (Compose, Send, Approve, the global
  search entry), `{rounded.md}` for everything else (icon buttons, ghost/segmented
  controls).
- **Primary:** solid `{colors.accent}` fill, `{colors.accent-foreground}` text. The only
  place solid accent-as-ground appears; everything else uses the soft tint.
- **Ghost (the default control voice):** transparent at rest, `{colors.hover}` under the
  pointer, `{colors.accent-soft}` + accent ink when "current" (a nav tab, a toggled view
  control, an armed toolbar icon). No compartments, no dividers, no uppercase letterspaced
  plates.
- **Press:** every button answers a press with `transform: scale(0.97)` — kept from the
  incumbent system because a control that answers nothing feels broken.

### Chips / Badges
- **Style:** `{rounded.sm}`, `{colors.field}` fill, `{colors.ink-muted}` text, label
  typography — folder pills, account badges, the Screener's Held count.
- The App Switcher's reserved-App badge ("SOON") is the one place a small caption still
  carries light tracking (0.03em) at 10px — a deliberate, restrained exception for a status
  chip, not a return to the old label voice.

### Cards / Containers
There are no bordered cards on the Mail surface. A "container" is a **tonal step**: a
compartment that changes background from `bg` to `surface`/`surface-strong` rather than
gaining a border. Settings and the Screener's per-sender cards are the one place a hairline
border (`{colors.border}`) still appears, to separate stacked compartments in a form-like
context — kept intentionally narrow to that context, not spread onto Mail rows.

### Inputs / Fields
- **Style:** `{colors.field}` fill (a step below the surface it sits on), no border at
  rest, `{rounded.md}`, 8px × 12px padding, body typography.
- **Focus:** ring in `{colors.accent}` (`:focus-visible`, 2px, 1px offset); caret is accent.
- **Composer fields (To/Cc/Subject/body):** placeholder-as-label, not a caption above the
  field — the composer never surfaces a separate uppercase field label.

### Navigation — the App Switcher (signature)
The left header cell: a `hub-mark` (a soft rounded-square tile carrying the postmark and a
badge for the current App) that expands, via a `grid-template-columns` transition, into a
row of pill tabs — one per App (Mail, Contacts, Calendar, Tasks) — when opened. The current
tab takes `{colors.accent-soft}` + accent ink and bold weight; a reserved App's tab carries
a small "SOON" caption rather than being disabled or hidden. Below 700px the switcher
collapses to icon-only pills.

### The Thread Row (signature)
A borderless, rounded (`{rounded.row}`) row on the page ground: sender (max 40%, ink-muted),
subject (flex, ink-faint), a right-aligned tabular-mono time, and a Done control that lives
in reserved whitespace, revealed on hover/keyboard-focus/selection (`data-armed`) rather than
inserted — arming it never reflows anything beside it. Hover takes `{colors.hover}`;
selection takes `{colors.accent-soft}` (a tint, never an inversion); unread bumps the sender
to full ink + weight 600 and leaves the subject at ink-muted — a read row steps back in
tone, an unread row never steps forward in size. Row height and its group header's height
taper across four tiers (see Layout) so the ladder itself carries rank, not just position.
No entrance animation, no stagger. Touch swipes reveal Archive (left) / Snooze or Trash
(right) under the row rather than needing the hover-revealed Done control.

### The Command Palette (signature)
A centered overlay (`{rounded.panel}`, `--shadow-overlay`, max 560px wide) behind a blurred
scrim, opened by ⌘K from anywhere in the app. One text field, then sectioned rows (Commands,
Mail results) each carrying a keycap for its binding. The active row takes
`{colors.accent-soft}`. Section captions are the Label tier — sentence case, 11.5px, weight
600, never uppercase. Entrance is a 150ms rise-and-scale (`--dur-fast`/`--ease-out`); the
Shortcut Sheet shares the same shell.

### The Screener (calm panel)
Deliberately the *quietest* screen in the app, not the loudest: each Unscreened Sender is a
plain `{colors.surface}` (selected: `{colors.accent-soft}`) card on the page ground — sender
identity, a peek line, and three actions (Approve solid-accent, Deny/Block ghost/outline).
No drenched color, no struck ink, no per-verdict color coding beyond the buttons themselves.
This is a deliberate departure from the old system's "one drenched fluorescent room" — the
Instrument treats screening as an ordinary triage surface, not a special occasion.

### Toasts
`{colors.surface}` ground, `{rounded.panel}`, `--shadow-overlay`, entering with an 8px
rise + fade over 150ms.

### Motion
The budget: `--dur-press` 120ms (presses, color/border changes, linear), `--dur-fast` 190ms
(toast/palette entry, disclosure rotation, and the *reveal* of a reserved-whitespace control),
`--dur-leave` 260ms (a row or card *departing* after an action, with up to 45ms of per-row
stagger, capped at eight rows). A list that reflows hundreds of times a session never
animates its own arrival — no entrance animation, no arrival stagger, anywhere in the thread
list. `prefers-reduced-motion: reduce` clamps every animation/transition in the app to 1ms.

**The Arrive-Silent, Leave-Visibly Rule (amended by #90).** Motion is encouraged wherever
it explains what just happened or is about to happen, and forbidden where it only decorates.
Rows never animate *in*: they are simply there. Rows *may* animate out when the User's action
removed them, because a row that vanishes in one frame reads as a bug. Controls that live in
reserved whitespace (a row's Done check) fade and scale into place over `--dur-fast` rather
than appearing; a Time Group header's Group Done check may *grow* and push the title right,
animated, because a header is one element and the reflow is felt as smooth rather than
jittery — Thread rows keep their fixed gutter and never reflow under the pointer. The
Timeline Spine appears and disappears over `--dur-fast`. Height still never animates on a
Thread row; it may on a single header. This supersedes the earlier "no stagger, nothing
animates height" wording, which described the first Instrument build rather than a principle.

## Do's and Don'ts

### Do:
- **Do** reach for `{colors.accent}`/`{colors.accent-soft}` for anything primary or
  "current." It is the only color that carries that meaning.
- **Do** separate regions by background-color step and whitespace, not by a hairline box.
- **Do** use the radius ladder (`sm` → `md` → `row` → `panel` → `pill`) — never an ad hoc
  value, never a Tailwind utility above `md` expecting anything but the same mapped corner.
- **Do** keep every label, caption, and heading in sentence case.
- **Do** set every machine-measured value (time, byte size, count, key cap) in Martian Mono
  with tabular figures.
- **Do** give an action reserved whitespace and reveal it on hover/focus/selection rather
  than inserting it and reflowing neighbors.
- **Do** keep `.app-shell` at `100dvh` + `overflow: hidden` and give every new routed screen
  its own `height: 100%; min-height: 0` scroller — this is what keeps the phone layout bugs
  fixed.
- **Do** use CONTEXT.md's vocabulary verbatim in UI copy: **Thread** not conversation,
  **Mail Account** not mailbox, **Screener** not quarantine, **Verdict** as
  Unscreened/Approved/Blocked.
- **Do** self-host faces from the app's own origin.

### Don't:
- **Don't** invert a selected/current element to solid ink. Rank is a soft tint, never an
  inversion, anywhere the rebuild has touched.
- **Don't** set a label, heading, or caption in uppercase with letterspacing — that is the
  old system's signature voice and does not belong in The Instrument (see below).
- **Don't** put a border around a Mail-surface row or panel to separate it from its
  neighbor; change its background instead.
- **Don't** give a control an ink color at rest. Ghost is the default voice: transparent →
  hover fill → soft-tint-when-current.
- **Don't** animate a list's *arrival* or stagger rows *in*. Departures and reveals follow the
  Arrive-Silent, Leave-Visibly Rule under Motion.
- **Don't** fetch a correspondent's image or a font from a CDN.
- **Don't** restyle a message body — it is third-party HTML in a sandboxed iframe and the
  design system stops at that boundary.

## Superseded vocabulary

The identity page for the old system (`docs/design/wicket-identity.html`, "Wicket / The
Sorting Office") carries a superseded-by header pointing here and is kept as history, not
deleted. Its retired typographic voice (`text-transform: uppercase` + 0.10–0.14em
letterspacing) was found surviving in the pre-auth screens (`auth/AuthCard.tsx`,
`auth/form-controls.tsx`, `auth/AuthGate.tsx`) and in Settings (`settings/settings.css`) —
the wordmark's tagline, every field label, the "SETTINGS" header, section captions and
buttons — during this ticket's finish review, and has been migrated to this system's
sentence-case Label tier. The one deliberate exception left in place is the App Switcher's
"SOON" badge on a reserved App's tab (`router/shell.css`'s `.tp-soon`), which keeps a light
0.03em tracking as a restrained status-chip treatment, not a return to the old voice —
it is not paired with `text-transform: uppercase` and the shipped literal copy is already
short and quiet ("SOON").
