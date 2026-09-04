---
name: The Instrument
description: A calm, ground-and-gap mail instrument — one electric accent, tonal surfaces, no hairlines on Mail, no plates.
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
  dark:
    bg: "#0c0d10"
    surface: "#101116"
    surface-strong: "#08090b"
    hover: "#17181e"
    field: "#16171d"
    field-strong: "#1e2027"
    ink: "#eef0f4"
    ink-muted: "#a4a8b5"
    ink-faint: "#6c7078"
    border: "#1e2027"
    accent: "#8b80ff"
    accent-foreground: "#0c0d10"
    accent-soft: "#1c1a33"
    danger: "#ff6f61"
    warn: "#f2ab4c"
    success: "#35c98a"
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
  header-height-phone: "54px"
  header-pad-x: "20px"
  gutter: "16px"
motion:
  dur-press: "120ms"
  dur-fast: "190ms"
  dur-leave: "260ms"
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
  card-raised:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    shadow: "card"
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

Regions are separated by **ground and gap**, never by joinery, on the Mail surface itself.
Settings is the one screen kept deliberately in a bordered, form-like frame (see
[Layout](#layout) and [Shapes](#shapes)) — a hairline still divides its stacked
compartments, because that screen reads as a form, not a scanned list. Rank between things
at rest elsewhere is expressed by a soft accent tint, not by inverting to solid ink and not
by a colored badge bolted onto the side of a row.

This replaces an older system ("Wicket / The Sorting Office" — institutional stock,
hairline joinery, struck ink, uppercase letterspaced "plates" for every label), fully
retired from the Mail surface, the chrome, and the App Switcher. See
[Superseded vocabulary](#superseded-vocabulary) for where its trace still needed finishing.

Since the prior recording, a 14-ticket batch (#90–#105) shipped the Hub's raised-card App
layout, the Home mark, Account Scope's move into the header, the Group Done grow-and-push
animation and its Timeline Spine preview, Drafts as list rows, Blocked Alias, and Stream —
a full-screen processing stack that replaces the retired Stream-view Device Preference
toggle. `mail/TopBar.tsx` was a real, 293-line persistent Mail toolbar on `main` (search field,
Account Scope, view-mode and density toggles, auto-advance, the Screener alert) before this
batch's #96 removed it; its actions were redistributed to the row's own reserved-whitespace
controls, the Group Header cluster, and the Command Palette instead.

**Key Characteristics:**
- One electric accent, everywhere rank or action needs marking; nothing else is decorative.
- Ground and gap on Mail: no hairline box around a control, no plate behind a row.
- Rank is a soft accent tint (`--color-accent-soft`) at rest, `--color-hover` under the
  pointer — nothing inverts to solid ink.
- Corners come from one ladder: control → row → panel → pill, never an ad hoc radius.
- Actions live in reserved whitespace, revealed on hover/focus rather than inserted, so
  arming a control never reflows its neighbors.
- Type carries rank by size and weight. Labels are sentence case, small, and quiet —
  **never uppercase, never letterspaced.**
- The document itself never scrolls: the shell owns the viewport, every routed pane scrolls
  on its own, and every App renders on a raised card over the Hub's own ground (full-bleed
  on the phone).
- shadcn primitives carry behavior and accessibility for every floating/overlay surface;
  every color and corner they render still comes from `@mail/design-tokens`.

## Colors

A near-white ground in light, a near-black one in dark, one electric accent that carries
every call to action, focus ring and selection, plus ink at three strengths and three
semantic signals. No per-feature colors: a new surface reaches for these same names.

### Primary
- **Accent** (`{colors.accent}`, `#4338ca` light / `#8b80ff` dark): the one electric color
  in the system — primary buttons (Compose, Send, Approve), the focus ring, text selection,
  the caret, the current nav tab/segment, a selected thread's tint, the unread dot, the
  Timeline Spine and the Group Done node. In dark it lifts to a lighter violet so it still
  reads as *the* accent against a near-black ground rather than needing extra contrast
  tricks.
- **Accent Soft** (`{colors.accent-soft}`): the quiet tint behind anything "current" — a
  selected thread row, the active nav tab, a Screener card that's selected. This, not solid
  ink, is how rank is shown at rest.

### Tertiary
- **Danger** (`{colors.danger}`): destructive actions and failure states (Block, delete,
  a failed send, error banners).
- **Warn** (`{colors.warn}`): held/attention states that are not failures.
- **Success** (`{colors.success}`): confirmed/admitted states (Approve, a completed send).

### Neutral
- **Bg** (`{colors.bg}`): the page ground. Body background.
- **Surface** (`{colors.surface}`): a raised surface on the ground — panels, popovers,
  the composer, cards, before hover.
- **Surface Strong** (`{colors.surface-strong}`): a step further off the ground — the
  global header, the Hub's own ground the raised App card sits on, the app-placeholder
  ground.
- **Hover** (`{colors.hover}`): any surface under pointer/keyboard interaction.
- **Field** / **Field Strong** (`{colors.field}` / `{colors.field-strong}`): a form
  control's fill at rest and once it holds focus or a value.
- **Ink** / **Ink Muted** / **Ink Faint** (`{colors.ink}` / `{colors.ink-muted}` /
  `{colors.ink-faint}`): primary text, secondary text (labels, metadata, a read row's
  sender/subject), and the quietest reading (placeholders, snippets, timestamps).
- **Border** (`{colors.border}`): a hairline whose permanent home is Settings' stacked form
  compartments and its side nav's edge; `.draft-row` (`mail.css`) also keeps one, but as its
  own doc comment says, only as an interim stand-in until Drafts gets the same
  margin/radius/hover treatment as `.thread-row` — not a second permanent context. Never used
  to box in an ordinary Mail row, a Thread List element, or the Screener's per-sender cards,
  which take the tonal-step (`{colors.surface}`) treatment everything else on the Mail
  surface does (`mail.css`'s `.screener-row`: `border: none`).

### The avatar tile palette
Five tinted fill/ink pairs (`{colors.tile-a-bg}`…`{colors.tile-e-bg}`) a correspondent's
initials circle is drawn from, picked deterministically off their name/address
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
reserved for anything a machine measured: timestamps, byte sizes, counts, group counts.
Tabular figures are on for `time` and `.tabular`.

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
signature "Label" voice and does not belong here — see [Superseded vocabulary](#superseded-vocabulary)
for where it still lingered as of this build.

## Layout

**The bounded-pane rule (standing policy).** `.app-shell` is `100dvh` with `overflow:
hidden` — never `min-height` or `100vh` — so the document itself never scrolls, at any
width. Whichever route is current (Mail, Settings, or a placeholder App —
`router/routes.tsx`) renders into `.app-viewport`, inside `.app-card`, and that route's own
top-level element is itself `height: 100%; min-height: 0` and scrolls independently. This is
a hard rule, not a convention: a new routed screen that grows past its own bounds without
this pattern regresses the two phone layout bugs #71 fixed (the virtualized Thread list
needing a bounded ancestor, and Settings being unreachable below the fold). Any new
top-level route must follow it.

**The Hub and the raised-card App layout.** The global header (`router/shell.css`'s
`.app-header`) sits on `--color-surface-strong` — the Hub's own ground. Beneath it,
`.app-viewport` also takes `--color-surface-strong`, and the current App renders inside
`.app-card`: at ≥701px the card gets `--radius-panel` and `--shadow-card` (a page-resident
elevation, distinct from `--shadow-overlay`) plus `12px` of padding around it, so the App
reads as a raised object sitting *on* the Hub rather than filling the frame; below 701px
that padding, radius, and shadow all drop to zero — full-bleed, matching the phone rule
followed everywhere else in the app (the folder rail's Sheet breakpoint, the same
700/701px line). The header's own `theme-color` meta tags (`index.html`) track this ground:
`#f5f5f8` light / `#08090b` dark, matching `--color-surface-strong` in each mode so a
phone's own chrome (status bar/task switcher) reads as part of the same instrument.

**The App Switcher (signature).** The left header cell is now two adjacent controls (split
in #96): a plain `Link` **Home mark** (`.home-link` — the mark, the wordmark, to `/mail`)
and, beside it, the **App Switcher** itself — a `hub-mark` tile carrying the current App's
icon that expands, via a `grid-template-columns` 0fr→1fr transition (280ms), into a row of
pill tabs, one per App (Mail, Contacts, Calendar, Tasks). The current tab takes
`{colors.accent-soft}` + accent ink and bold weight; a reserved App's tab carries a small
"SOON" caption rather than being disabled or hidden. Below 640px the wordmark and the tab
labels disappear, leaving icon-only pills and the mark.

**The global header** is a fixed 60px (54px on phone), three-column grid
(`minmax(0,1fr) auto minmax(0,1fr)`) — Home mark + App Switcher on the left, one centered
search *entry* (a button that raises the Command Palette, not a text field) in the middle,
Account Scope + appearance toggle + avatar menu on the right — so the search field centers
on the *viewport*, not on whatever space is left beside the switcher.

**Row geometry is load-bearing and tapered, not flat.** The thread list ranks
reverse-chronologically by *scale*, not just position: four tiers taper from 54px
(Pinned/Today) down to 32px (Older/Undated), with header heights tapering 26px → 20px plus a
26px lead baked into each header's own height (a virtualized row can't carry a margin the
virtualizer never measured). These values live once in `mail/taper.ts` and are consumed both
as `VirtualizedThreadList`'s `estimateSize` and as the row's own inline height — change them
in one place or the virtualizer and the rendered box disagree. `compact` density shifts every
tier by a fixed delta (-6px rows, -8px headers) rather than flattening the taper to one size.
An ungrouped list (search results) is flat at the T2 row height (46px comfortable) with no
taper and no group headers at all.

**Responsive.** Below 700/701px: the list/detail split collapses to one pane at a time (both
stay mounted, one hidden), the permanent folder rail becomes a bottom sheet (a real shadcn
`Sheet`) behind `.side-nav-toggle`, the Group Header's bulk actions collapse into a single
always-visible overflow button that opens its own `Sheet` rather than relying on hover, and
the header's row of view controls goes icon-only. `env(safe-area-inset-*)` is added
unconditionally to every edge-touching pad.

### Named Rules
**The Bounded Pane Rule.** `.app-shell` is `100dvh` + `overflow: hidden`; every routed pane
is its own `height: 100%; min-height: 0` scroller. No exceptions — this is how the phone
layout bugs stay fixed.

**The Ground-and-Gap Rule (Mail-scoped).** On the Mail surface, regions separate by
background-color change and whitespace, not by a hairline box or a card. A control that
needs a boundary gets `{rounded.md}` and `{colors.field}`, not a 1px border around a
`{colors.surface}` box. Settings is the named exception: see Shapes/Components.

## Elevation & Depth

Mostly flat: depth is tonal (`bg` → `surface` → `surface-strong` → `hover`/`accent-soft`),
and rank is a soft accent tint. The system carries **three** shadow tokens today, each with
one job — this build's own reality has grown past the earlier "exactly one shadow" framing,
and the distinction is real, not decorative.

### Shadow Vocabulary
- **Overlay** (`--shadow-overlay` = `0 16px 40px -12px rgb(20 21 26/.20), 0 4px 14px -4px
  rgb(20 21 26/.12)`; dark: `0 22px 50px -14px rgb(0 0 0/.6), 0 6px 16px -4px rgb(0 0 0/.45)`):
  things that genuinely float *over* the frame — the Command Palette, the Shortcut Sheet,
  the composer, popovers, dialogs (Screener's View dialog), toasts, Stream's cards.
- **Card** (`--shadow-card` = `0 1px 2px rgb(20 21 26/.05), 0 6px 20px -10px rgb(20 21 26/.16)`;
  dark: `0 1px 2px rgb(0 0 0/.3), 0 8px 24px -12px rgb(0 0 0/.5)`): a page-resident element
  that sits raised *in place* rather than opening over everything — the App's own raised
  card on the Hub (`.app-card`, ≥701px only). A shallower recipe than overlay on purpose: the
  App isn't announcing itself the way a popover does.
- **Header** (`--shadow-header`, an inset relief: `inset 0 1px 0 white/.5, inset 0 -1px 2px
  ink/.045, 0 1px 2px ink/.03`): the global header's separation from the ground — a fixed
  three-layer recipe, not a drop shadow, because the header never floats *above* anything,
  it sits at the top of the same ground.

### Named Rules
**The Float vs. Rest vs. Frame Rule.** If it's part of the frame at rest, it has no shadow
(Mail rows, Group Headers, Settings compartments). If it's raised in place on the page
(the App card), it takes `--shadow-card`. If it floats *over* the frame (Palette, popover,
dialog, composer, toast, Stream card), it takes `--shadow-overlay`.

## Shapes

One radius ladder, walked by every surface: `{rounded.sm}` (6px, inline chips), `{rounded.md}`
(8px, the default control corner — buttons, inputs, icon buttons), `{rounded.row}` (11px, a
list row or menu item — the comp's own row corner), `{rounded.panel}` (16px, anything that
floats or is raised: the Command Palette, a popover, the composer, the App's raised card,
Stream's cards), `{rounded.pill}` (999px, Compose, the global search entry, primary
Send/Approve buttons, the Hub's Home/Switcher pills). Every Tailwind radius step from `md` up
maps onto this same ladder in `index.css`'s `@theme inline` block, so a `rounded-2xl` utility
cannot smuggle in an off-ladder corner.

The correspondent mark is a **circle**, filled from the tile palette, carrying initials drawn
from the name/address — never a fetched image, since remote images stay blocked until a
sender is Approved (the Verdict *is* the image-loading permission, so "sender avatars" is
closed by the identity rather than a missing feature).

Icons are a single Lucide stroke set at 1.6px weight (set once in `index.css`, not per call
site) — the hand-authored solid pictogram set from the old system is gone. The postmark mark
(`brand/Mark.tsx`) is the one drawn signature glyph that survives, on the same 24 grid as
every Lucide icon so weights line up; it appears in the Home mark and at the pre-auth card.

**Settings is the one bordered exception.** Its side nav (`settings/SettingsLayout.tsx`) is
a plain vertical list of `Link`s — not shadcn's `Sidebar` primitive, even though `Sidebar` is
available and used elsewhere (Mail's own folder rail, `mail/Sidebar.tsx`). Each
`.settings-nav-item` is a ghost row (`{rounded.row}`, `{colors.accent-soft}` when
`data-status="active"`) inside a fixed 200px rail divided from the content by
`{colors.border}`; each `.settings-page section` is a stacked compartment divided from the
next by the same hairline. This is a deliberate, narrow exception to ground-and-gap, kept to
Settings' form-like context — it does not spread onto Mail rows or panels, and the Screener's
per-sender cards use the same tonal-step treatment those do, not a hairline.

## Components

### Buttons
- **Shape:** `{rounded.pill}` for primary actions (Compose, Send, Approve, the global
  search entry), `{rounded.md}` for everything else (icon buttons, ghost/segmented
  controls).
- **Primary:** solid `{colors.accent}` fill, `{colors.accent-foreground}` text. The only
  place solid accent-as-ground appears; everything else uses the soft tint.
- **Ghost (the default control voice):** transparent at rest, `{colors.hover}` under the
  pointer, `{colors.accent-soft}` + accent ink when "current" (a nav tab, a toggled view
  control). No compartments, no dividers, no uppercase letterspaced plates.
- **Press:** every button answers a press with `transform: scale(0.97)` — kept from the
  incumbent system because a control that answers nothing feels broken.

### Chips / Badges
- **Style:** `{rounded.sm}`, `{colors.field}` fill, `{colors.ink-muted}` text, label
  typography — folder pills, account badges, the Screener's Held count, group-header counts
  (in Martian Mono).
- The App Switcher's reserved-App badge ("SOON") is the one place a small caption still
  carries light tracking (0.03em) at 10px — a deliberate, restrained exception for a status
  chip, not a return to the old label voice.

### Cards / Containers
There are no bordered cards on the Mail surface. A "container" is a **tonal step**: a
compartment that changes background from `bg` to `surface`/`surface-strong` rather than
gaining a border. The App itself is the one page-level exception to "no cards": `.app-card`
is a genuinely raised card (see Elevation), but it carries no border, only `--shadow-card`.
Settings is the one place a hairline border (`{colors.border}`) still appears, to separate
stacked compartments in a form-like context — kept intentionally narrow to that context, not
spread onto Mail rows or the Screener's per-sender cards, which take the tonal-step
treatment instead.

### Inputs / Fields
- **Style:** `{colors.field}` fill (a step below the surface it sits on), no border at
  rest, `{rounded.md}`, 8px × 12px padding, body typography.
- **Focus:** ring in `{colors.accent}` (`:focus-visible`, 2px, 1px offset); caret is accent.
- **Composer fields (To/Cc/Subject/body):** placeholder-as-label, not a caption above the
  field — the composer never surfaces a separate uppercase field label.

### Navigation — the Hub, Home mark, and App Switcher (signature)
The header's left cell now holds two adjacent controls: a plain-`Link` **Home mark**
(`HomeLink.tsx`, `.home-link`) to `/mail`, and beside it the **App Switcher**
(`AppSwitcher.tsx`) — a `hub-mark` tile (a soft rounded-square carrying the current App's
icon) that expands into a row of pill tabs on click. Every App the current user's instance
supports is named and reachable, never hidden and never disabled; a reserved App
(Contacts/Calendar/Tasks) carries a small "SOON" caption on its own tab instead. The
current App renders on a raised card over the Hub's ground (see Layout) rather than as a
same-level pane beside the switcher.

### The Thread Row (signature)
A borderless, rounded (`{rounded.row}`) row on the page ground: sender (max 40%, ink-muted),
subject (flex, ink-faint), a right-aligned tabular-mono time, and a Done control that lives
in a reserved 26px gutter, revealed on hover/keyboard-focus/selection (`data-armed`) rather
than inserted — arming it never reflows anything beside it. Hover takes `{colors.hover}`;
selection takes `{colors.accent-soft}` (a tint, never an inversion); unread bumps the sender
to full ink + weight 600 and leaves the subject at ink-muted — a read row steps back in
tone, an unread row never steps forward in size. Row height and its group header's height
taper across four tiers (see Layout) so the ladder itself carries rank, not just position.
No entrance animation, no stagger. Touch swipes reveal Archive (right) / Snooze (left) under
the row rather than needing the hover-revealed Done control (`useSwipeToTriage.ts`; there is
no Trash swipe). Drafts render in their own `.draft-row` compartment (`DraftsView.tsx`), not
as ordinary thread rows in the same list — its own hairline (`mail.css`'s `.draft-row`) sets
it apart; deleting one issues a real IMAP expunge rather than a soft local hide.

### The Time Group header, its Group Done check, and the Timeline Spine (signature,
previously undocumented)
Each `.group-header` is a flush, ground-colored band (never a plate) whose height also
tapers across the same four tiers as its rows (26px → 20px, plus a fixed 26px lead baked
into the header's own height rather than a margin). Inside it, `.group-header-cluster`
reserves the same 26px gutter (`.gh-rail`) every row below reserves for its own Done
control, so the header's **Group Done** node lands exactly above the column of row Done
controls and any spine it lights runs straight down through them.

At rest the Group Done node (`.gh-node`) is an 8px accent dot, centered in that gutter. When
the cluster is armed (`data-armed="true"`, driven by real hover/focus/tap state, never a bare
`:hover`) the node **grows** — width/height animate 8px → 24px over `--dur-fast` (190ms,
`--ease`) while its checkmark glyph grows from 0 into a 12px icon in step — into a real,
clickable "mark this whole group Done" target. This is a genuine size change on a header
element, which the Motion section calls out as the one place height/size is allowed to
animate on a Thread List element. The header's own row of Mark-all/Collapse actions
(`.bulk-actions`) lives in the same reserved trailing space, sliding in from a 6px offset
under the same armed state — reserving room rather than reflowing the label or the count.

**The Timeline Spine.** Hovering (or focusing) the Group Done node alone — not the cluster's
broader armed state — previews the *whole group's* pending action: a 2px accent line fades
in (`opacity` over `--dur-fast`) down the `.gh-rail`'s own matching segment *and* down every
row's `.row-check::before` segment in that group, at `left: 13px` in each gutter, so the two
draw as one continuous line rather than two independently-lit ones. Both sides key off the
same `data-group-preview` state, driven by one `onPreview` callback, specifically so a header
armed by hovering only its label text can never light the spine without the row segments
matching it.

### The Command Palette (signature)
A centered overlay (`{rounded.panel}`, `--shadow-overlay`, max 560px wide) behind a blurred
scrim, opened by ⌘K from anywhere in the app — outside `/mail` the chord is caught by the
shell and replayed once Mail is mounted, since the Palette itself is Mail-scoped. One text
field, then sectioned rows (Commands, Mail results) each carrying a keycap for its binding.
The active row takes `{colors.accent-soft}`. Section captions are the Label tier — sentence
case, 11.5px, weight 600, never uppercase. Entrance is a `--dur-fast` (190ms) rise-and-scale
(`--ease-out`); the Shortcut Sheet shares the same shell. Built on `cmdk`
directly, not the shadcn `Command` wrapper.

### shadcn primitive vocabulary
The component layer is shadcn primitives wired to `@mail/design-tokens`' colors/corners,
used selectively rather than uniformly:
- **Sonner** (`components/ui/sonner.tsx`) — the one toast surface, mounted once as
  `<Toaster />` in `RootLayout`.
- **Popover** — Snooze and label-picker menus off the reading pane's own action row
  (`ThreadDetailPane.tsx`).
- **Context Menu** — the Thread List's right-click action menu (`actions/ActionMenu.tsx`),
  with the full submenu/checkbox/shortcut vocabulary.
- **Sheet** — the phone's folder rail (`mail/Sidebar.tsx`) and the Group Header's phone
  overflow actions (`VirtualizedThreadList.tsx`), both as bottom sheets below the 700px
  breakpoint.
- **Sidebar** — the desktop/tablet folder rail only (`mail/Sidebar.tsx`). **Not** used for
  Settings' side nav, which is a plain `Link` list (`settings/SettingsLayout.tsx`) styled
  directly in `settings.css` — despite `Sidebar` being available in `components/ui`, Settings
  deliberately did not reach for it.
- **Dialog** — the Screener's View dialog (below) and the Blocked Alias confirmation.
- **Command** primitive file is not present; the Command Palette is hand-built on `cmdk`.

### The Screener (calm panel) and its View dialog
Deliberately the *quietest* screen in the app, not the loudest: each Unscreened Sender is a
plain `{colors.surface}` (selected: `{colors.accent-soft}`) card on the page ground — sender
identity, a peek line, and actions (Approve solid-accent, Deny/Block/Block domain/Spam/Block
alias ghost). No drenched color, no struck ink, no per-verdict color coding beyond the
buttons themselves. Opening a card's **View** raises a real shadcn `Dialog`
(`ScreenerViewDialog.tsx`, `--shadow-overlay`, `{rounded.panel}`) — the decision actions
repeated at the top, then every held Thread from that sender stacked underneath, rendered
through the same sandboxed `MessageBody` reader used elsewhere but forced `interactive={false}`
so remote images stay blocked and links stay inert without a second sandbox config to keep in
sync. Acting from inside the dialog closes it and the Screener list drops that sender on the
same tick — the dialog's "decided" disappearance is the row's, just viewed from inside.

### Stream (full-screen processing stack)
Its own route (`mail/stream/StreamStack.tsx`, `stream.css`), replacing the retired
`.stream-view` Device Preference toggle entirely — there is no more in-list Stream mode.
A `.stream-card-top` (`{rounded.panel}`, `--shadow-overlay`, the same reading surface as the
Thread detail pane) sits centered over a quiet peeking sliver of the next card
(`.stream-card-peek`, no actions, no click target — "something is next," nothing more).
Deciding a card follows Leave-Visibly: the outgoing card animates out
(`stream-card-leave`, `--dur-leave`, translateY(-16px) + fade + slight scale-down) and is
`pointer-events: none` while leaving so a second click can't act twice; the next card simply
appears underneath, Arrive-Silent.

### Toasts
`{colors.surface}` ground, `{rounded.panel}`, `--shadow-overlay`, entering with an 8px
rise + fade over `--dur-fast` (190ms), via Sonner.

### Motion
The budget: `--dur-press` 120ms (presses, color/border changes, linear), `--dur-fast` 190ms
(toast/palette entry, disclosure rotation, and the *reveal* or *growth* of a reserved-space
control), `--dur-leave` 260ms (a row, card, or group departing after an action, with up to
45ms of per-row stagger, capped at eight rows — the same token now drives the Thread List's
group-clear stagger, Stream's card-leave animation, and any future "departing after an
action" case, rather than each hand-copying its own duration). A list that reflows hundreds
of times a session never animates its own arrival — no entrance animation, no arrival
stagger, anywhere in the Thread List or Stream. `prefers-reduced-motion: reduce` clamps every
animation/transition in the app to 1ms.

**The Arrive-Silent, Leave-Visibly Rule (amended by #90–#105).** Motion is encouraged
wherever it explains what just happened or is about to happen, and forbidden where it only
decorates. Rows and cards never animate *in*: they are simply there. Rows and cards *may*
animate out when the User's action removed them, because something that vanishes in one
frame reads as a bug. Controls that live in reserved whitespace (a row's Done check) fade
and scale into place over `--dur-fast` rather than appearing; a Time Group header's Group
Done check may *grow* — a genuine width/height animation — because a header is one element
and the reflow reads as smooth rather than jittery, while Thread rows themselves keep their
fixed gutter and never reflow under the pointer. The Timeline Spine fades in and out over
`--dur-fast`, keyed to the same hover/focus state as the node it previews. Height still never
animates on a Thread row; it may on a single header or a Stream card leaving. This supersedes
the earlier "no stagger, nothing animates height" wording, which described the first
Instrument build rather than a durable principle.

## Do's and Don'ts

### Do:
- **Do** reach for `{colors.accent}`/`{colors.accent-soft}` for anything primary or
  "current." It is the only color that carries that meaning.
- **Do** separate Mail-surface regions by background-color step and whitespace, not by a
  hairline box; keep the hairline exception to Settings.
- **Do** use the radius ladder (`sm` → `md` → `row` → `panel` → `pill`) — never an ad hoc
  value, never a Tailwind utility above `md` expecting anything but the same mapped corner.
- **Do** keep every label, caption, and heading in sentence case.
- **Do** set every machine-measured value (time, byte size, count, key cap) in Martian Mono
  with tabular figures.
- **Do** give an action reserved whitespace and reveal — or, on a header element only, grow
  — it on hover/focus/selection rather than inserting it and reflowing neighbors.
- **Do** keep `.app-shell` at `100dvh` + `overflow: hidden` and give every new routed screen
  its own `height: 100%; min-height: 0` scroller — this is what keeps the phone layout bugs
  fixed.
- **Do** render a new App on the raised `.app-card`, full-bleed on phone, matching the Hub's
  `theme-color` in both modes.
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
- **Don't** animate a list's or Stream's *arrival* or stagger cards/rows *in*. Departures and
  reveals follow the Arrive-Silent, Leave-Visibly Rule under Motion.
- **Don't** fetch a correspondent's image or a font from a CDN.
- **Don't** restyle a message body — it is third-party HTML in a sandboxed iframe and the
  design system stops at that boundary, including inside the Screener's View dialog and
  Stream's cards.
- **Don't** reach for shadcn `Sidebar` by default for a new side-nav — Settings' plain
  `Link` list is the shipped precedent for a simple, non-collapsible rail; `Sidebar` is for
  Mail's own folder rail, which needs its collapse/Sheet behavior.
- **Don't** revive the Mail toolbar or the in-list Stream toggle. Both were part of earlier
  planning; neither exists in the shipped build. Stream is its own route; row/group/palette
  actions cover what a toolbar would have.

## Superseded vocabulary

The identity page for the old system (`docs/design/wicket-identity.html`, "Wicket / The
Sorting Office") carries a superseded-by header pointing here and is kept as history, not
deleted. Its retired typographic voice (`text-transform: uppercase` + letterspacing) has
been migrated to this system's sentence-case Label tier everywhere the rebuild has
touched — the pre-auth screens (`auth/AuthCard.tsx`, `auth/form-controls.tsx`,
`auth/AuthGate.tsx`) and Settings (`settings/settings.css`) carry no `uppercase` at all as of
this build. Two places still do, and neither has been through this rebuild:

- **The PWA update banner** (`index.css`'s `.pwa-update-banner` and its own button): still
  full old-voice — `text-transform: uppercase`, 0.09–0.1em letterspacing, on both the
  banner's copy and its "Reload"-style button. Not yet touched by the rebuild; a future
  ticket should bring it to the sentence-case Label tier rather than treat it as an
  intentional exception.
- **The App Switcher's "SOON" badge** (`router/shell.css`'s `.tp-soon`) keeps a light 0.03em
  tracking as a deliberate, restrained status-chip treatment, not a return to the old
  voice — it is not paired with `text-transform: uppercase` and the shipped literal copy is
  already short and quiet ("SOON").

**Retired, not carried forward as system rules:** the in-list Stream toggle
(`.stream-view` Device Preference) and the standalone Mail toolbar (`mail/TopBar.tsx`),
which #96 deleted after it shipped and rode on `main`, redistributing its actions to the
Thread Row's reserved gutter, the Group Header cluster, and the Command Palette — that
redistribution is why those three surfaces carry the actions they do. Neither is present in
the shipped tree; Stream is now its own full-screen route. Don't revive either: a future
ticket should treat a lingering reference to one as documentation drift, not as a target to
rebuild toward.
