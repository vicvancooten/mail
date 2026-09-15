---
name: The Instrument
description: A calm, ground-and-gap mail instrument — one electric accent, tonal surfaces, no hairlines on Mail, no plates, one scale, chrome that floats.
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
  title:
    fontFamily: "Inter Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 620
    letterSpacing: "-0.01em"
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
    fontFamily: "Inter Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "11.5px"
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
  header-height-phone: "52px"
  header-pad-x: "20px"
  gutter: "16px"
  chrome-top-phone: "calc(52px + env(safe-area-inset-top))"
  chrome-bottom-phone: "calc(52px + 12px + env(safe-area-inset-bottom))"
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-5: "20px"
  space-6: "24px"
  space-7: "32px"
  control-sm: "28px"
  control-md: "32px"
  control-primary: "38px"
  control-touch: "44px"
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
    padding: "0 18px"
    height: "{spacing.control-primary}"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
  button-ghost-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  button-ghost-current:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  button-ghost-sm:
    height: "{spacing.control-sm}"
  segmented-track:
    backgroundColor: "{colors.field}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
  segmented-thumb:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
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
    padding: "0 10px"
    height: "24px"
  chip-tag-selected:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
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
  dock-pill:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    padding: "4px"
  dock-tile:
    backgroundColor: "transparent"
    rounded: "{rounded.pill}"
    height: "{spacing.control-touch}"
    width: "{spacing.control-touch}"
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

A completed 10-ticket polish pass (#314–#323, `docs/design/polish-pass.md`) took the same
world further: **chrome now floats over content instead of framing it** (the phone header
and dock are translucent, blurred glass; every phone scroller pads itself by
`--chrome-top`/`--chrome-bottom` instead of the chrome reserving a slab), **one shared
control vocabulary** (`controls.css`'s `.btn-primary`/`.btn-ghost`/`.segmented`/`.chip`)
replaced four Apps' four separate button dialects, **one type-and-space scale**
(`@mail/design-tokens`'s `space`/`text`/`controlHeight` ladders) replaced fourteen ad hoc
font sizes and thirteen ad hoc paddings, **Martian Mono is retired** — every machine value
now sets in Inter with tabular figures — and **Tasks was brought into the same idiom** as
Mail (its rail now reuses `.side-nav`, its List/Board switch is a `Segmented`, its quick-add
is a ghost row, its board columns are ground-and-gap). None of this changes the palette, the
one accent, ground-and-gap, the taper, the Hub, or the App Switcher — see
`docs/design/polish-pass.md` for the full diagnosis and R1–R5 rule set this section and
Layout/Shapes/Components/Motion below now encode as the shipped system.

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
- **One control vocabulary, everywhere:** `.btn-primary` (the one solid-accent action per
  App), `.btn-ghost` (the default voice), `.segmented` (pick one view), `.chip` (a filter or
  tag) — no hairline-bordered button anywhere outside Settings.
- **One scale:** type sizes 11.5/13/14/17/21, space 4/8/12/16/20/24/32, control heights
  28/32/38/44 — any other value in `apps/client` CSS is a defect unless `mail/taper.ts` owns
  it.
- **Chrome floats on phone**, translucent and blurred, never a slab; every scroller reserves
  its own clearance instead of the chrome reserving space for itself.
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
  selected thread row, the active nav tab, a segmented control's own thumb never uses this
  (it uses `{colors.surface}`; see Components), a Screener card that's selected, a selected
  filter chip. This, not solid ink, is how rank is shown at rest.

### Tertiary
- **Danger** (`{colors.danger}`): destructive actions and failure states (Block, delete,
  a failed send, error banners).
- **Warn** (`{colors.warn}`): held/attention states that are not failures.
- **Success** (`{colors.success}`): confirmed/admitted states (Approve, a completed send).

### Neutral
- **Bg** (`{colors.bg}`): the page ground. Body background; also the phone chrome's own
  blend-through color (`--chrome` blur backgrounds are `color-mix()` against this).
- **Surface** (`{colors.surface}`): a raised surface on the ground — panels, popovers,
  the composer, cards, before hover; also a segmented control's sliding thumb.
- **Surface Strong** (`{colors.surface-strong}`): a step further off the ground — the
  global header at ≥768px, the Hub's own ground the raised App card sits on, the
  app-placeholder ground.
- **Hover** (`{colors.hover}`): any surface under pointer/keyboard interaction.
- **Field** / **Field Strong** (`{colors.field}` / `{colors.field-strong}`): a form
  control's fill at rest and once it holds focus or a value; `{colors.field}` is also a
  segmented control's own track and a chip's own fill.
- **Ink** / **Ink Muted** / **Ink Faint** (`{colors.ink}` / `{colors.ink-muted}` /
  `{colors.ink-faint}`): primary text, secondary text (labels, metadata, a read row's
  sender/subject), and the quietest reading (placeholders, snippets, timestamps).
- **Border** (`{colors.border}`): a hairline whose permanent home is Settings' stacked form
  compartments and its side nav's edge. The polish pass finished `.draft-row`'s own deferred
  migration off this color onto the `.thread-row` margin/radius/hover treatment (`mail.css`)
  — it no longer carries a border. Never used to box in an ordinary Mail row, a Thread List
  element, a Calendar toolbar, a Contacts tab strip, a Tasks split list, a Tasks quick-add
  row, or a Sheet's own bottom edge — every one of those hairlines the polish pass found
  leaking outside Settings (`docs/design/polish-pass.md` diagnosis #4) is gone.

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
**Machine values:** also Inter Variable, `font-variant-numeric: tabular-nums` — a second,
imported mono face (Martian Mono) used to carry timestamps, byte sizes, counts, and keycaps;
the polish pass retired it entirely (`packages/design-tokens/src/typography.ts`'s own
docstring: "Martian Mono retired entirely"). `fonts.mono` is now a plain system stack
(`ui-monospace, SFMono-Regular, Menlo, monospace`) kept for exactly one genuinely code-like
run: the compose send-failure banner's verbatim SMTP rejection text. Email addresses (the
Screener's row/view, the Reader's Contact Card) also moved off mono onto the Secondary tier
(13px, ink-muted) as part of the same retirement.

### Hierarchy
- **Heading** (650, 21px, -0.017em, `text-wrap: balance`): the open Thread's subject —
  the loudest text in the app, and the only place that size appears.
- **Title** (620, 17px, -0.01em): a pane header — Tasks, Contacts, Notes, Calendar, and
  Settings page headers all now share this one tier (R4's "pane title tier",
  `docs/design/polish-pass.md`) instead of each App picking its own size.
- **Body** (400, 14px, 1.5): a thread row's subject/sender, message content, running UI text.
- **Secondary** (400, 13px): meta lines, the reading pane's correspondent line, snippets,
  email addresses.
- **Label** (600, 11–11.5px, sentence case): section labels, group-header names, the command
  palette's section captions, a chip's own text. Small and quiet, never uppercase and never
  letterspaced.
- **Machine** (Inter, 11.5–12px, tabular, ink-faint): timestamps, group counts, byte sizes,
  key caps (a keycap is now Inter 11.5px weight 600 on `{colors.field}`, `{rounded.sm}`, not
  a mono chip).

### Named Rules
**The Sentence-Case Rule.** Every label, heading, and caption in the rebuilt system is
sentence case. `text-transform: uppercase` plus 0.10em+ tracking was the old system's
signature "Label" voice and does not belong here — see [Superseded vocabulary](#superseded-vocabulary)
for where it still lingers outside the rebuild's own scope.

**The One Voice, One Face Rule.** There is exactly one sans face (Inter) for every measured
and every written value in the app. A second imported face for "machine" values was tried
and retired (Martian Mono); the only face outside Inter left in the system is the
system-`ui-monospace` stack, reserved for the one run of genuine code (an SMTP rejection).

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
`.app-header`) sits on `--color-surface-strong` — the Hub's own ground — at ≥768px, with an
inset-relief `--shadow-header` separating it from the ground beneath (see Elevation). Beneath
it, `.app-viewport` also takes `--color-surface-strong`, and the current App renders inside
`.app-card`: at ≥768px the card gets `--radius-panel` and `--shadow-card` (a page-resident
elevation, distinct from `--shadow-overlay`) plus `12px` of padding around it, so the App
reads as a raised object sitting *on* the Hub rather than filling the frame; below 768px
that padding, radius, and shadow all drop to zero — full-bleed, matching the phone rule
followed everywhere else in the app (the folder rail's Sheet breakpoint, the same
768px line — see **Responsive breakpoint** below).

**Chrome floats over content on phone (R1, the polish pass's own headline rule).** Below
768px the header and the Dock no longer frame the content by reserving space for
themselves — `.app-shell` declares `--chrome-top: calc(52px + env(safe-area-inset-top))`
and `--chrome-bottom: calc(52px + 12px + env(safe-area-inset-bottom))` (both `0px` at
≥768px), and it is every phone scroller's own job to pad itself by those two variables
(`padding-top`/`padding-bottom` plus matching `scroll-padding-*`) so its first and last rows
can still scroll clear — the Thread list, the reading pane, the Screener, Drafts, Stream's
stack, Settings, Tasks' split list and main pane, Contacts' grid, Notes' grid, the Calendar
toolbar and grid, Recently Deleted, search results, and the App placeholder all carry this
padding now. The header itself (phone, `.app-header` below 767px) is `position: fixed`,
52px tall, background `color-mix(in srgb, var(--color-bg) 78%, transparent)`,
`backdrop-filter: blur(18px) saturate(1.3)`, **no shadow, no border** — the blur alone reads
as "above" the content. The Dock (below) is the same idea applied to a floating pill. This
replaces the earlier build's opaque phone header slab and the "gray bar" of reserved-but-
unused ground beneath the old dock (`docs/design/polish-pass.md`'s diagnosis #1) — neither
exists in the shipped tree. The single `theme-color` meta (`index.html`'s pre-paint script,
`theme/device-theme.ts`) tracks whichever ground the chrome now blends into: below 768px
`--color-bg` (`#fbfbfc` light / `#0c0d10` dark, since the phone header is translucent over
that ground), at or above it `--color-surface-strong` (`#f5f5f8` light / `#08090b` dark, the
opaque desktop header's own paint) — so a phone's own chrome (status bar/task switcher) reads
as part of the same instrument whichever width it's seen at. `manifest.webmanifest` carries
no `theme_color` of its own (an installed Android WebAPK freezes its status bar on the
manifest's own color at install time and never re-reads the meta tag; with nothing to freeze
on, it falls back to the live meta this module already keeps current) — `background_color`
(the cold-load splash) stays.

**The phone Dock (signature, redesigned).** A floating glass pill (`router/Dock.tsx`,
`shell.css`'s `.dock`) fixed at the screen's bottom edge, centered with a gutter on every
side rather than pinned edge to edge — the page's own `--color-bg` ground shows all the way
round it. Background `color-mix(in srgb, var(--color-surface) 72%, transparent)`,
`backdrop-filter: blur(20px) saturate(1.4)`, `box-shadow: var(--shadow-overlay), inset 0 0 0
0.5px color-mix(in srgb, var(--color-ink) 8%, transparent)` — the inset ring stands in for a
hairline border this app otherwise reserves for Settings, since `--shadow-overlay` alone
reads flat on a light blurred surface with no edge of its own. Grammar is
`[switcher][navControl?][primaryAction]` — never more than three tiles: the leading App
Switcher tile (the current App's icon on a 28px `--radius-md` accent-soft square, no
chevron, no App name), the current App's `navControl` if it declares one (Folders for Mail,
Calendars for Calendar, Lists for Tasks; none for Contacts and Notes, so their Dock is a
two-tile pill), and the App's one `primaryAction`. Every tile is 44×44 (`--control-touch`),
`--radius-pill`, **icon-only** — no caption text survives inside the pill (the old dock's
icon-over-caption tiles, a bordered switcher tile with a chevron and a variable-width label,
and a 10.5px caption size found nowhere else are gone; `docs/design/polish-pass.md`'s
diagnosis #2). `aria-label` carries the full spoken name (e.g. "New Contact", not a bare
"New"). Compose is the one tile that keeps a bit of personality (the plus turns 90° on
press) but stays ghost like every sibling — a solid disc that small reads as a bolted-on
FAB, the phone-app cliché this system's register rules out. Retracts downward off-screen
together with the header on scroll-down, same mechanism and timing (`useChromeRetract.ts`,
`data-chrome-hidden`).

**One primary action per App, in one place (R3).** Each App declares exactly one primary
action (`apps/apps.ts#AppDef.primaryAction`: Compose for Mail, New contact, New event, New
task, New note) plus an optional `navControl`. `apps/primary-action.ts#usePrimaryAction`
resolves the handler once and is shared by both surfaces that render it: the desktop
header's `<PrimaryAction>` (`RootLayout.tsx`, header-right, before Account Scope — a
`.btn-primary` accent pill with the App's icon and label) and the phone Dock's trailing
tile. Nothing else on screen is solid accent. Mail's rail `.compose-btn` was removed once
the header carried Compose (`c` still composes); Tasks' "New task" focuses the current
view's quick-add row instead of navigating.

**The App Switcher (signature, desktop).** The left header cell is two adjacent controls
(split in #96): a plain `Link` **Home mark** (`.home-link` — the mark, the wordmark, to
`/mail`) and, beside it, the **App Switcher** itself — a `hub-mark` tile carrying the current
App's icon that expands, via a `grid-template-columns` 0fr→1fr transition (280ms), into a row
of pill tabs, one per App (Mail, Contacts, Calendar, Tasks, Notes). The current tab takes
`{colors.accent-soft}` + accent ink and bold weight; a reserved App's tab carries a small
"SOON" caption rather than being disabled or hidden. On desktop, once the header runs out of
room for five full names the row goes icon-only — a width measurement
(`AppSwitcher.tsx`'s own `ResizeObserver`), not a fixed breakpoint. This is the desktop shape
only — the header's own instance of the switcher (and the Home mark beside it) drops out of
the tree entirely below 768px; the phone bottom Dock's leading tile opens the same
`PhoneSwitcher` Sheet listing all five Apps by full name instead.

**Account Scope is a per-App question (#187).** `apps.ts#AppDef.observesAccountScope` — true
for Mail, Calendar and Contacts (each reads a Mail Account's data), false for Tasks and Notes
(User-scoped data, nothing to narrow). The Hub hides the header-right control entirely on an
App that doesn't observe it, rather than rendering it disabled or empty.

**The global header** is a fixed 60px (52px on phone), three-column grid
(`minmax(0,1fr) auto minmax(0,1fr)`) — Home mark + App Switcher on the left, one centered
search *entry* (a button that raises the Command Palette, not a text field) in the middle,
Account Scope + appearance toggle + avatar menu on the right — so the search field centers
on the *viewport*, not on whatever space is left beside the switcher. On phone this drops to
just the search entry and Account Scope in the centre/right; the appearance toggle folds into
`AvatarMenu`'s own radio group.

**Retract on scroll.** The header and the dock retract together on scroll-down and return on
scroll-up, on phone only (`router/useChromeRetract.ts`, a capture-phase `scroll` listener) —
`transform: translateY(...)` over `--dur-fast`/`--ease-out`, a pure transform now that no
padding-collapse counterpart is needed (the polish pass removed the
`[data-chrome-hidden] .app-viewport` padding rules, since content no longer stops for chrome
in the first place).

**Row geometry is load-bearing and tapered, not flat.** The thread list ranks
reverse-chronologically by *scale*, not just position: four tiers taper from 54px
(Pinned/Today) down to 32px (Older/Undated), with header heights tapering 26px → 20px plus a
26px lead baked into each header's own height. These values live once in `mail/taper.ts` and
are consumed both as `VirtualizedThreadList`'s `estimateSize` and as the row's own inline
height. `compact` density shifts every tier by a fixed delta (-6px rows, -8px headers) rather
than flattening the taper to one size. `mail/taper.ts` is the one place in `apps/client` CSS
exempt from the R4 scale below — it predates and defines rank-by-size rather than consuming
the shared ladder.

**Responsive.** Below 768px: the list/detail split collapses to one pane at a time (both
stay mounted, one hidden, and the incoming pane now plays a `pane-enter` push-from-the-right
transition rather than a hard `display: none` swap — see Motion), the permanent folder rail
becomes a bottom Sheet opened from the dock's own Folders tile, the Group Header's bulk
actions collapse into a single always-visible overflow button that opens its own Sheet, and
the header's row of view controls goes icon-only. `env(safe-area-inset-*)` is added
unconditionally to every edge-touching pad.

**Responsive breakpoint.** One number, **768px**, is the only phone breakpoint the Client
reads, in TypeScript and CSS alike (`@mail/design-tokens#phoneBreakpoint`,
`hooks/use-phone-width.ts`'s `useIsPhoneWidth`/`isPhoneWidth`) — every phone-detecting call
site in the app shares it (`AppSwitcher.tsx`, `RootLayout.tsx`'s `isPhoneChrome`,
`SettingsLayout.tsx`, `use-touch-phone.ts`, the shadcn `Sidebar` primitive, and
`theme/device-theme.ts`'s own `theme-color` resolution).

### Named Rules
**The Bounded Pane Rule.** `.app-shell` is `100dvh` + `overflow: hidden`; every routed pane
is its own `height: 100%; min-height: 0` scroller. No exceptions — this is how the phone
layout bugs stay fixed.

**The Ground-and-Gap Rule (Mail-scoped).** On the Mail surface, regions separate by
background-color change and whitespace, not by a hairline box or a card. A control that
needs a boundary gets `{rounded.md}` and `{colors.field}`, not a 1px border around a
`{colors.surface}` box. Settings is the named exception: see Shapes/Components.

**The Chrome-Floats Rule (phone-scoped, R1).** On phone, the header and the Dock are
translucent, blurred, and sit on top of the scrolling pane, never around it. Content never
pads for a slab; every scroller pads itself by `--chrome-top`/`--chrome-bottom` instead. A
new phone-visible scroller that omits this padding regresses the same "content stops for
chrome" defect the polish pass fixed everywhere else.

## Elevation & Depth

Mostly flat: depth is tonal (`bg` → `surface` → `surface-strong` → `hover`/`accent-soft`),
and rank is a soft accent tint. The system carries **three** shadow tokens, each with one
job.

### Shadow Vocabulary
- **Overlay** (`--shadow-overlay` = `0 16px 40px -12px rgb(20 21 26/.20), 0 4px 14px -4px
  rgb(20 21 26/.12)`; dark: `0 22px 50px -14px rgb(0 0 0/.6), 0 6px 16px -4px rgb(0 0 0/.45)`):
  things that genuinely float *over* the frame — the Command Palette, the Shortcut Sheet,
  the composer, popovers, dialogs (Screener's View dialog), toasts, Stream's cards, and now
  the phone Dock's own floating pill.
- **Card** (`--shadow-card` = `0 1px 2px rgb(20 21 26/.05), 0 6px 20px -10px rgb(20 21 26/.16)`;
  dark: `0 1px 2px rgb(0 0 0/.3), 0 8px 24px -12px rgb(0 0 0/.5)`): a page-resident element
  that sits raised *in place* rather than opening over everything — the App's own raised
  card on the Hub (`.app-card`, ≥768px only), and the `Segmented` thumb's own small lift off
  its track.
- **Header** (`--shadow-header`, an inset relief: `inset 0 1px 0 white/.5, inset 0 -1px 2px
  ink/.045, 0 1px 2px ink/.03`): the desktop (≥768px) global header's separation from the
  ground — a fixed three-layer recipe, not a drop shadow. The phone header takes **no**
  shadow at all (R1): blur alone carries its separation from the content scrolling beneath
  it.

### Named Rules
**The Float vs. Rest vs. Frame Rule.** If it's part of the frame at rest, it has no shadow
(Mail rows, Group Headers, Settings compartments, the phone header). If it's raised in place
on the page (the App card, the Segmented thumb), it takes `--shadow-card`. If it floats
*over* the frame (Palette, popover, dialog, composer, toast, Stream card, the phone Dock),
it takes `--shadow-overlay`.

## Shapes

One radius ladder, walked by every surface: `{rounded.sm}` (6px, chips), `{rounded.md}`
(8px, the default control corner — ghost buttons, inputs, icon buttons, the segmented
track), `{rounded.row}` (11px, a list row or menu item), `{rounded.panel}` (16px, anything
that floats or is raised: the Command Palette, a popover, the composer, the App's raised
card, Stream's cards), `{rounded.pill}` (999px, the one primary action per App, the global
search entry, the Hub's Home/Switcher pills, and now the phone Dock's own pill and every
tile inside it). Every Tailwind radius step from `md` up maps onto this same ladder in
`index.css`'s `@theme inline` block, so a `rounded-2xl` utility cannot smuggle in an
off-ladder corner.

**The one scale (R4).** Beyond radius, three more ladders are the whole sizing vocabulary of
`apps/client`: **space** (4/8/12/16/20/24/32, `@mail/design-tokens#space`, emitted as
`--space-1`…`--space-7`), **text** (11.5/13/14/17/21, `#text`, emitted as
`--text-label`/`--text-secondary`/`--text-body`/`--text-title`/`--text-heading`), and
**control height** (28/32/38/44, `#controlHeight`, emitted as
`--control-sm`/`--control-md`/`--control-primary`/`--control-touch`). Before this, font
sizes in use ranged across fourteen distinct values and paddings across thirteen — every App
picked its own (`docs/design/polish-pass.md`'s diagnosis #6). Any other value found in
`apps/client` CSS today is a defect unless `mail/taper.ts` owns it (Mail's own row/header
geometry, which predates and defines rank-by-scale rather than consuming this ladder).

The correspondent mark is a **circle**, filled from the tile palette, carrying initials drawn
from the name/address — never a fetched image, since remote images stay blocked until a
sender is Approved (the Verdict *is* the image-loading permission, so "sender avatars" is
closed by the identity rather than a missing feature).

Icons are a single Lucide stroke set at 1.6px weight (set once in `index.css`, not per call
site) — the hand-authored solid pictogram set from the old system is gone, and the polish
pass's own control sweep replaced the last two hand-drawn glyphs: Calendar's `‹ ›` text
characters are now `ChevronLeft`/`ChevronRight`, and Tasks' List/Board `<select>` is now a
`Segmented`. The postmark mark (`brand/Mark.tsx`) is the one drawn signature glyph that
survives, on the same 24 grid as every Lucide icon so weights line up; it appears in the Home
mark and at the pre-auth card.

**Settings is the one bordered exception.** Its side nav (`settings/SettingsLayout.tsx`) is
a plain vertical list of `Link`s — not shadcn's `Sidebar` primitive, even though `Sidebar` is
available and used elsewhere (Mail's own folder rail, `mail/Sidebar.tsx`). Each
`.settings-nav-item` is a ghost row (`{rounded.row}`, `{colors.accent-soft}` when
`data-status="active"`) inside a fixed 200px rail divided from the content by
`{colors.border}`; each `.settings-page section` is a stacked compartment divided from the
next by the same hairline. This is a deliberate, narrow exception to ground-and-gap, kept to
Settings' form-like context. The polish pass's hairline sweep confirmed every other
hairline-bordered control it found (Calendar's toolbar, Contacts' tab strip, Tasks' split
list and quick-add, Drafts' row, a Sheet's own `border-t`) was leakage, not a second
exception — all are gone now, either onto a tonal-step/`Segmented`/`.chip` treatment or, for
the Sheet's `border-t`, removed outright as part of the Motion rewrite (see Components).

## Components

### Buttons
One shared control vocabulary (`controls.css`, R2) now backs every App — the polish pass's
own diagnosis found three separate button dialects (a solid pill, a hairline-bordered pill
on `{colors.surface}`, and a ghost pill, with filters and buttons sharing the pill shape so
nothing told them apart) and collapsed them to two shapes plus two composite controls below.
- **`.btn-primary`** (`{rounded.pill}`, `{spacing.control-primary}` = 38px): the **one**
  solid-accent action per App (Compose, New contact, New event, New task, New note, Send,
  Approve) — solid `{colors.accent}` fill, `{colors.accent-foreground}` text, weight 600.
  Nothing else in the system is solid accent-as-ground; hover brightens (`filter:
  brightness(1.06)`), press scales `0.97`.
- **`.btn-ghost`** (`{rounded.md}`, `{spacing.control-md}` = 32px, or `.btn-ghost--sm` at
  `{spacing.control-sm}` = 28px): the default control voice everywhere else — transparent at
  rest, `{colors.ink-muted}` text, `{colors.hover}` fill on hover, `{colors.accent-soft}` +
  accent ink when `[aria-pressed="true"]` or `.current`. `.btn-icon` makes it a square icon
  button (still requires its own `aria-label` — the icon alone is never an accessible name).
  No hairline-bordered buttons remain anywhere outside Settings; Calendar's "Today", Contacts'
  and Tasks' back buttons, and every header icon button now share this one class.
- **Press:** every button answers a press with `transform: scale(0.97)` over `--dur-press`
  (120ms) — kept from the incumbent system because a control that answers nothing feels
  broken.

### Segmented (pick one of several views)
`.segmented` (`components/Segmented.tsx`) is a `role="radiogroup"` of ghost text options
(13px, weight 550) inside a `{colors.field}` track (`{rounded.md}`, `{spacing.control-md}` =
32px); the current option's `{colors.surface}` thumb (`--shadow-card`) slides under it via
`--seg-index`/`--seg-count` custom properties set inline, `transform` over `--dur-fast`
`--ease-out`. One implementation shared by Calendar's view switcher, Contacts' tab strip
(whose own hairline underline is gone), and Tasks' List/Board switch (formerly a bare
`<select>`) — three hand-rolled pills before the polish pass, one shape and one motion budget
now. Full roving-tabindex + arrow-key keyboard support (native radiogroup pattern).

### Chips / Badges
- **`.chip`** (24px, `{rounded.sm}`, `{colors.field}` fill, `{colors.ink-muted}` text, Label
  typography, sentence case): filters, tags, facets, folder pills, account badges, the
  Screener's Held count, group-header counts (now in Inter tabular, not Martian Mono).
  Selected state (`[aria-pressed="true"]`) is `{colors.accent-soft}` + accent ink. A
  removable chip carries a small `X` icon button (`.chip-remove`) at the shared 1.6-stroke
  Lucide weight, never a bespoke glyph. A chip that names a fact rather than a control
  (`span.chip`, e.g. a Label on a Mail row) drops the pointer affordance.
- The App Switcher's reserved-App badge ("SOON") is the one place a small caption still
  carries light tracking (0.03em) at 10px — a deliberate, restrained exception for a status
  chip, not a return to the old label voice.

### Cards / Containers
There are no bordered cards on the Mail surface. A "container" is a **tonal step**: a
compartment that changes background from `bg` to `surface`/`surface-strong` rather than
gaining a border. The App itself is the one page-level exception to "no cards": `.app-card`
is a genuinely raised card (see Elevation), but it carries no border, only `--shadow-card`.
Tasks' board columns are the same idea applied to a board: `{colors.surface}` columns on
`{colors.bg}`, ground-and-gap, no hairlines. Settings is the one place a hairline border
(`{colors.border}`) still appears, to separate stacked compartments in a form-like context.

### Inputs / Fields
- **Style:** `{colors.field}` fill (a step below the surface it sits on), no border at
  rest, `{rounded.md}`, 8px × 12px padding, body typography.
- **Focus:** ring in `{colors.accent}` (`:focus-visible`, 2px, 1px offset); caret is accent.
- **Composer fields (To/Cc/Subject/body):** placeholder-as-label, not a caption above the
  field — the composer never surfaces a separate uppercase field label.
- **Tasks' quick-add** (formerly a bordered form): now a ghost row reading "+ Add a task" at
  the top of the list, taking `{colors.field}` only while focused, no border at rest — the
  App's `primaryAction` focuses it directly rather than navigating.

### Navigation — the Hub, Home mark, and App Switcher (signature)
The header's left cell holds two adjacent controls: a plain-`Link` **Home mark**
(`HomeLink.tsx`, `.home-link`) to `/mail`, and beside it the **App Switcher**
(`AppSwitcher.tsx`) — a `hub-mark` tile (a soft rounded-square carrying the current App's
icon) that expands into a row of pill tabs on click. Every App the current user's instance
supports is named and reachable, never hidden and never disabled; a reserved App carries a
small "SOON" caption on its own tab instead. On phone, both drop out of the header entirely
in favor of the Dock's own leading switcher tile (see Layout).

### The Dock (signature, phone-only, redesigned)
See Layout's own "The phone Dock" entry for the full grammar, sizing, and materials
(`[switcher][navControl?][primaryAction]`, icon-only, blurred glass pill). Registry-driven:
`apps.ts#AppDef.primaryAction` (one `{ key, label, icon }`) plus `AppDef.navControl?` decide
what each App's Dock renders; `apps/primary-action.ts#usePrimaryAction` is the one shared
handler resolution, so the Dock and the desktop header's `<PrimaryAction>` can never drift
apart.

### The Thread Row (signature)
A borderless, rounded (`{rounded.row}`) row on the page ground: sender (max 40%, ink-muted),
subject (flex, ink-faint), a right-aligned tabular time (Inter, not mono), and a Done control
that lives in a reserved 26px gutter, revealed on hover/keyboard-focus/selection
(`data-armed`) rather than inserted — arming it never reflows anything beside it. Hover takes
`{colors.hover}`; selection takes `{colors.accent-soft}` (a tint, never an inversion); unread
bumps the sender to full ink + weight 600 and leaves the subject at ink-muted. Row height and
its group header's height taper across four tiers (see Layout). No entrance animation, no
stagger. Touch swipes reveal Archive (right) / Snooze (left) under the row rather than
needing the hover-revealed Done control; there is no Trash swipe. Drafts render in their own
`.draft-row` compartment (`DraftsView.tsx`) — as of the polish pass this finally shares the
same margin/radius/hover treatment as `.thread-row` rather than keeping its own interim
hairline.

### The Time Group header, its Group Done check, and the Timeline Spine (signature)
Each `.group-header` is a flush, ground-colored band (never a plate) whose height also
tapers across the same four tiers as its rows. Inside it, `.group-header-cluster` reserves
the same 26px gutter (`.gh-rail`) every row below reserves for its own Done control, so the
header's **Group Done** node lands exactly above the column of row Done controls. At rest the
Group Done node is an 8px accent dot; armed (`data-armed="true"`), it **grows** — width/height
animate 8px → 24px over `--dur-fast` — into a clickable "mark this whole group Done" target,
the one place height/size is allowed to animate on a Thread List element.

**The Timeline Spine.** Hovering (or focusing) the Group Done node alone previews the *whole
group's* pending action: a 2px accent line fades in down the header's own rail segment *and*
down every row's own segment in that group, drawing as one continuous line.

### The Command Palette (signature)
A centered overlay (`{rounded.panel}`, `--shadow-overlay`, max 560px wide) behind a blurred
scrim, opened by ⌘K from anywhere in the app. One text field, then sectioned rows (Commands,
Mail results) each carrying a keycap (now Inter 11.5px weight 600 on `{colors.field}`,
`{rounded.sm}` — not Martian Mono) for its binding. The active row takes
`{colors.accent-soft}`. Section captions are the Label tier. Built on `cmdk` directly, not
the shadcn `Command` wrapper.

### shadcn primitive vocabulary
The component layer is shadcn primitives wired to `@mail/design-tokens`' colors/corners,
used selectively rather than uniformly:
- **Sonner** — the one toast surface, mounted once as `<Toaster />` in `RootLayout`.
- **Popover** — Snooze and label-picker menus off the reading pane's own action row.
- **Hover Card** — the Reader's Contact Card, off the sender avatar.
- **Context Menu** — the Thread List's right-click action menu, and (since the polish pass)
  Tasks' list rail's own rename/delete menu, matching the Thread Row's reserved-gutter
  pattern instead of always-visible pencil/trash icons.
- **Sheet** — the phone's folder rail, the Group Header's phone overflow actions, and Tasks'
  own List rail below 768px (opened from the Dock's Lists tile) — all below the 768px
  breakpoint. The polish pass rewrote the Sheet's own bottom-variant motion (see Motion) and
  removed its `border-t`.
- **Sidebar** — the desktop/tablet folder rail only. **Not** used for Settings' side nav.
- **Dialog** — the Screener's View dialog, the Blocked Alias confirmation, the compose
  Send/Don't send prompt, and the Shortcut Sheet (`?`).
- **Command** primitive file is not present; the Command Palette is hand-built on `cmdk`.

### Transient surfaces: the shared-primitive rule
Every popover, menu, dialog and sheet is a Radix-backed shadcn primitive — never a
hand-managed `open` boolean with its own `mousedown`/`keydown` listeners bolted on. A
component can still hold its own `open` state as long as it's only ever handed to the
primitive as `open`/`onOpenChange`. Exemptions: the Command Palette (`cmdk`), editor-caret-
anchored typeahead popups (the compose recipient combobox, the slash menu), and the desktop
App Switcher's own inline `grid-template-columns` expansion (a `Popover` cannot animate from
zero width in place; the phone variant is a real `Sheet` and needs no exemption).

### The Screener (calm panel) and its View dialog
The quietest screen in the app: each Unscreened Sender is a plain `{colors.surface}`
(selected: `{colors.accent-soft}`) card on the page ground — sender identity, a peek line
(email addresses now Inter 13px ink-muted, not mono), and actions (Approve solid-accent,
Deny/Block/Block domain/Spam/Block alias ghost). Opening a card's **View** raises a real
shadcn `Dialog` (`--shadow-overlay`, `{rounded.panel}`).

### Stream (full-screen processing stack)
`.stream-card-top` (`{rounded.panel}`, `--shadow-overlay`) sits centered over a quiet peeking
sliver of the next card. Deciding a card follows Leave-Visibly: the outgoing card animates out
(`--dur-leave`, translateY(-16px) + fade + slight scale-down) and is `pointer-events: none`
while leaving; the next card simply appears underneath, Arrive-Silent. Phone padding narrows
the desktop 24px card/peek insets to 12–16px, and now also reserves `--chrome-top`/
`--chrome-bottom` like every other phone scroller.

### Tasks (brought into the shared idiom)
The polish pass's own diagnosis called Tasks "a different product" — a hairline-divided
sidebar with always-visible pencil/trash icons, a "Pick a Task List." landing state, a
`<select>` for view mode, a bordered quick-add form, and a phone sidebar screen you had to
"back" out of. All five are gone:
- **Rail** (`TasksSidebar.tsx`) now shares Mail's `.side-nav`/`.nav-item` idiom — ghost rows
  at `{rounded.row}`, current = accent-soft, no right hairline, a Label-tier "Lists" caption
  above the Task Lists. Rename/delete moved to a right-click Context Menu plus a hover/focus-
  revealed `…` button in a reserved 24px gutter — the Thread Row pattern, never
  always-visible.
- **Landing** is Today on every width; "Pick a Task List." is gone.
- **Phone:** the rail is a bottom Sheet opened by the Dock's own Lists tile (the Folders
  pattern) — the main pane is always the screen, never a second "back" level.
- **Main pane header:** back (phone only, `.btn-ghost.btn-icon`), title at the Title tier
  (17px), `Segmented` List/Board switch at the right.
- **Quick add:** the ghost row described under Inputs above.
- **Completed:** `TasksCompletedGroup.tsx` — a real `<button aria-expanded>` in Mail's
  `.group-header` idiom (label + tabular count), collapsible, replacing three separate
  hand-rolled `<details>`/`<summary>` implementations across `TaskListView.tsx`,
  `TaskTodayView.tsx`, and `TaskUpcomingView.tsx`.
- **Board columns:** ground-and-gap (`{colors.surface}` columns on `{colors.bg}`), no
  hairlines (see Cards/Containers).
- **Task complete:** the check draws (`stroke-dashoffset`) over `--dur-fast` before the row
  leaves (see Motion).

### Toasts
`{colors.surface}` ground, `{rounded.panel}`, `--shadow-overlay`, entering with an 8px
rise + fade over `--dur-fast` (190ms), via Sonner.

### Motion
The budget: `--dur-press` 120ms (presses, color/border changes, linear), `--dur-fast` 190ms
(toast/palette entry, disclosure rotation, the segmented thumb's own slide, and the *reveal*
or *growth* of a reserved-space control), `--dur-leave` 260ms (a row, card, or group
departing after an action, with up to 45ms of per-row stagger, capped at eight rows; also a
bottom Sheet's own rise). A list that reflows hundreds of times a session never animates its
own arrival — no entrance animation, no arrival stagger, anywhere in the Thread List or
Stream. `prefers-reduced-motion: reduce` clamps every animation/transition in the app to 1ms.

**What the polish pass added (R5): motion that explains a change of place or state, once.**
Before it, bottom sheets only faded and slid 2.5rem with `ease-in-out`, a phone's list-to-
detail transition was a hard `display: none` swap, segments snapped, and only Mail rows and
Stream cards had any authored motion at all (`docs/design/polish-pass.md`'s diagnosis #7).
Now:
- **Sheets** (`components/ui/sheet.tsx`, bottom variant) rise `translateY(100%) → 0` over
  `--dur-leave` `--ease-out` on enter, reverse over `--dur-fast` on exit, behind a scrim
  fading over `--dur-fast`; the `border-t` and `tw-animate-css` slide utilities it used to
  carry are gone, replaced by two keyframes authored once in `shell.css`.
- **Phone detail push:** the incoming pane in `.split-view.has-selection .split-pane`,
  Tasks' equivalent, and Contacts' equivalent plays `pane-enter`
  (`translateX(24px)` + opacity 0 → 1, `--dur-fast`, `--ease-out`) on mount, replacing the
  hard `display: none` swap.
- **Segment thumb** slides via `transform` over `--dur-fast` `--ease-out` (see Components).
- **Task complete:** the check draws before the row leaves.
All of the above are clamped by the same `prefers-reduced-motion` rule as everything else;
none needed its own escape hatch.

**The Arrive-Silent, Leave-Visibly Rule (unchanged by the polish pass).** Motion is
encouraged wherever it explains what just happened or is about to happen, and forbidden
where it only decorates. Rows and cards never animate *in*: they are simply there. Rows and
cards *may* animate out when the User's action removed them. Controls that live in reserved
whitespace fade and scale into place over `--dur-fast` rather than appearing; a Time Group
header's Group Done check may *grow*. Height still never animates on a Thread row; it may on
a single header, a Stream card leaving, or (new) a Sheet rising from the bottom edge.

## Do's and Don'ts

### Do:
- **Do** reach for `{colors.accent}`/`{colors.accent-soft}` for anything primary or
  "current." It is the only color that carries that meaning.
- **Do** separate Mail-surface regions by background-color step and whitespace, not by a
  hairline box; keep the hairline exception to Settings.
- **Do** use the radius ladder (`sm` → `md` → `row` → `panel` → `pill`) — never an ad hoc
  value, never a Tailwind utility above `md` expecting anything but the same mapped corner.
- **Do** use the shared control vocabulary (`.btn-primary`, `.btn-ghost`, `Segmented`,
  `.chip`) for any new button, tab strip, or filter — never a bespoke bordered pill.
- **Do** snap every new font size, padding, and control height to the shared ladders
  (`space`/`text`/`controlHeight` in `@mail/design-tokens`) — `mail/taper.ts` is the one
  named exception.
- **Do** keep every label, caption, and heading in sentence case.
- **Do** set every machine-measured value (time, byte size, count, key cap) in Inter with
  tabular figures — no separate mono face outside the compose SMTP rejection text.
- **Do** give an action reserved whitespace and reveal — or, on a header element only, grow
  — it on hover/focus/selection rather than inserting it and reflowing neighbors.
- **Do** keep `.app-shell` at `100dvh` + `overflow: hidden` and give every new routed screen
  its own `height: 100%; min-height: 0` scroller.
- **Do** pad a new phone-visible scroller by `--chrome-top`/`--chrome-bottom` — chrome floats,
  it never reserves space for itself.
- **Do** render a new App on the raised `.app-card`, full-bleed on phone, matching the Hub's
  `theme-color` in both modes and widths.
- **Do** give a new App exactly one `primaryAction` and, only if it needs one, one
  `navControl`, resolved through `apps/primary-action.ts` so the header and the Dock stay in
  lockstep.
- **Do** use CONTEXT.md's vocabulary verbatim in UI copy: **Thread** not conversation,
  **Mail Account** not mailbox, **Screener** not quarantine, **Verdict** as
  Unscreened/Approved/Blocked.
- **Do** self-host faces from the app's own origin.

### Don't:
- **Don't** invert a selected/current element to solid ink. Rank is a soft tint, never an
  inversion, anywhere the rebuild has touched.
- **Don't** set a label, heading, or caption in uppercase with letterspacing — that is the
  old system's signature voice and does not belong in The Instrument (see below).
- **Don't** put a border around a Mail-surface row, panel, toolbar, tab strip, or Sheet edge
  to separate it from its neighbor; change its background instead, or reach for `Segmented`/
  `.chip`. The polish pass found and removed every instance of this outside Settings.
- **Don't** give a control an ink color at rest. Ghost is the default voice: transparent →
  hover fill → soft-tint-when-current.
- **Don't** hand-roll a second button/tab/filter shape. `.btn-primary`/`.btn-ghost`/
  `Segmented`/`.chip` are the whole vocabulary; a fourth dialect is the defect the polish
  pass exists to have fixed.
- **Don't** pick an off-ladder font size, padding, or control height. Any value outside
  `space`/`text`/`controlHeight` (or `mail/taper.ts`) is a defect, not a new precedent.
- **Don't** animate a list's or Stream's *arrival* or stagger cards/rows *in*. Departures and
  reveals follow the Arrive-Silent, Leave-Visibly Rule under Motion.
- **Don't** reach for a second mono/imported face for a machine value. Martian Mono is
  retired; Inter tabular carries every measured value, and the system `ui-monospace` stack
  is reserved for the one verbatim code-like run.
- **Don't** let a phone chrome element (header, Dock) reserve layout space for itself, and
  don't let a new phone scroller skip its own `--chrome-top`/`--chrome-bottom` padding — that
  is exactly the "gray bar" defect the polish pass fixed.
- **Don't** fetch a correspondent's image or a font from a CDN.
- **Don't** restyle a message body — it is third-party HTML in a sandboxed iframe and the
  design system stops at that boundary, including inside the Screener's View dialog and
  Stream's cards.
- **Don't** reach for shadcn `Sidebar` by default for a new side-nav — Settings' plain
  `Link` list is the shipped precedent for a simple, non-collapsible rail; `Sidebar` is for
  Mail's own folder rail (and, now, matched in spirit by Tasks' own `.side-nav`-idiom rail),
  which needs collapse/Sheet behavior.
- **Don't** revive the Mail toolbar, the in-list Stream toggle, or Tasks' old bordered
  quick-add/hairline sidebar/`<select>` view switch. None exist in the shipped build.
- **Don't** treat "no bottom tab bar" as still true on phone, and don't treat the phone
  chrome as opaque or shadowed. Both are current, shipped facts of this system, not planning
  language to defend against.

## Superseded vocabulary

The identity page for the old system (`docs/design/wicket-identity.html`, "Wicket / The
Sorting Office") carries a superseded-by header pointing here and is kept as history, not
deleted. Its retired typographic voice (`text-transform: uppercase` + letterspacing) has
been migrated to this system's sentence-case Label tier everywhere the rebuild and the
polish pass have touched — the pre-auth screens, Settings, and the PWA update banner (now
fully on the shared `space`/`text` ladder, no uppercase, as of the polish pass's scale sweep)
carry no `uppercase` at all as of this build.

**Not yet migrated, and out of the polish pass's own scope:** several form-section captions
in Calendar, Contacts, Tasks, and Notes (e.g. `calendar.css`, `contacts.css`,
`contact-dialog.css`, `notes/note-editor.css`) still carry `text-transform: uppercase` on
field-group captions. The polish pass's own R2–R4 sweep targeted buttons, tabs, filters, the
type/space scale, and the hairlines it named explicitly; it did not audit every remaining
uppercase caption across all four secondary Apps. These are recorded here as a known,
unfinished migration — not as a confirmed second voice a new screen should imitate.

**The App Switcher's "SOON" badge** (`router/shell.css`'s `.tp-soon`) keeps a light 0.03em
tracking as a deliberate, restrained status-chip treatment, not a return to the old
voice — it is not paired with `text-transform: uppercase` and the shipped literal copy is
already short and quiet ("SOON").

**Retired, not carried forward as system rules:** the in-list Stream toggle
(`.stream-view` Device Preference), the standalone Mail toolbar (`mail/TopBar.tsx`), the
pre-polish-pass phone dock (icon-over-caption tiles, a bordered chevron switcher tile, four
control voices), and Tasks' pre-polish-pass shape (hairline sidebar, always-visible
pencil/trash icons, "Pick a Task List." landing, `<select>` view switch, bordered quick-add,
sidebar-as-a-screen on phone). None of these are present in the shipped tree. Don't revive
any of them; a future ticket should treat a lingering reference to one as documentation
drift, not as a target to rebuild toward.
