---
name: Wicket
description: Self-hosted mail with a door on it — an institutional sorting frame, two stocks and four inks.
colors:
  frame: "#d5d8ce"
  panel: "#e7e8e0"
  panel-2: "#dddfd5"
  panel-sunk: "#c9cdc1"
  rule: "#bec2b5"
  rule-hard: "#9aa093"
  ink: "#1f1d18"
  ink-2: "#575349"
  ink-3: "#65624f"
  aniline: "#5b3e8c"
  fluor: "#9c3000"
  fluor-flat: "#ff5a0f"
  postal: "#b0231c"
  phosphor: "#256b42"
  bone: "#f4f2e9"
  # The sender's own ground, not ours: the sandboxed message-body iframe and
  # the PDF preview. The design system stops at that boundary.
  sender-ground: "#ffffff"
typography:
  display:
    fontFamily: "Archivo Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "27px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontVariation: "wdth 118"
  headline:
    fontFamily: "Archivo Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.012em"
    fontVariation: "wdth 96"
  title:
    fontFamily: "Archivo Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.008em"
    fontVariation: "wdth 96"
  body:
    fontFamily: "Archivo Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
    fontVariation: "wdth 100"
  sender:
    fontFamily: "Archivo Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 620
    lineHeight: 1.4
    letterSpacing: "normal"
    fontVariation: "wdth 92"
  label:
    fontFamily: "Archivo Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 620
    lineHeight: 1.2
    letterSpacing: "0.11em"
    fontVariation: "wdth 78"
  machine:
    fontFamily: "Martian Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  legend:
    fontFamily: "Archivo Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.14em"
    fontVariation: "wdth 78"
  secondary:
    fontFamily: "Archivo Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    fontVariation: "wdth 100"
  field:
    fontFamily: "Archivo Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    fontVariation: "wdth 100"
  micro:
    fontFamily: "Martian Mono Variable, ui-monospace, Menlo, monospace"
    fontSize: "9px"
    fontWeight: 500
  strike:
    fontFamily: "Archivo Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "21px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.16em"
    fontVariation: "wdth 70"
rounded:
  band: "1px"
  plate: "2px"
  hair: "1px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "9px"
  lg: "12px"
  xl: "14px"
  2xl: "18px"
  3xl: "22px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.frame}"
    typography: "{typography.label}"
    rounded: "{rounded.plate}"
    padding: "6px 12px"
  button-primary-hover:
    backgroundColor: "{colors.ink-2}"
    textColor: "{colors.frame}"
  button-secondary:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.plate}"
    padding: "6px 11px"
  button-secondary-hover:
    backgroundColor: "{colors.panel-sunk}"
    textColor: "{colors.ink}"
  button-destructive:
    backgroundColor: "transparent"
    textColor: "{colors.postal}"
    typography: "{typography.label}"
    rounded: "{rounded.plate}"
    padding: "6px 11px"
  button-held:
    backgroundColor: "transparent"
    textColor: "{colors.fluor}"
    typography: "{typography.label}"
    rounded: "{rounded.plate}"
    padding: "5px 10px"
  input-field:
    backgroundColor: "{colors.frame}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.plate}"
    padding: "9px 11px"
  chip-label:
    backgroundColor: "{colors.panel-sunk}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.band}"
    padding: "1px 6px"
  row-thread:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "0 14px"
    height: "60px"
  row-thread-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.frame}"
    height: "60px"
  row-thread-compact:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    padding: "0 12px"
    height: "40px"
  plate-head:
    backgroundColor: "{colors.panel-sunk}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    padding: "7px 12px"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.frame}"
    typography: "{typography.body}"
    rounded: "{rounded.plate}"
    padding: "9px 15px"
  screener-surface:
    backgroundColor: "{colors.fluor-flat}"
    textColor: "{colors.ink}"
    padding: "13px 16px"
---

# Design System: Wicket

<!-- One ramp, no half-steps: 9 / 10 / 11 / 12 / 13 / 14 / 16 / 21 / 27px. -->

## Overview

**Creative North Star: "The Sorting Office"**

Wicket is a room, not a page. The ground is never paper: the light theme is the day bench — institutional pale grey-green enamel and painted steel — and the dark theme is the night frame, warm near-black aged hardwood with text in bone, the colour of label stock, never blue graphite and never white. Kraft is the item; the app is the joinery around it. Compartments divide on hairline rules that meet at the corners. There are no cards, no gaps between compartments, and only one shadow in the entire system.

The system ranks by inversion, never by brightness or by weight. A selected Thread takes the ink and turns its stock inside out; a read Thread steps back in tonal value rather than the unread one stepping forward in bold. Controls take no ink colour at all — relief and rule only. Colour is reserved for four role inks, each of which appears only for its own job, so a row is never ambiguous about what happened to it. The saturated fluorescent orange of the Screener exists because you are in that bay for fifteen seconds a day; that scarcity is what buys it the right to be drenched.

State is struck across the item, never badged beside it. The `.strike` primitive prints an uppercase, tilted, ruled word over the thing whose state changed, blended into its stock. It is scoped by hard contract to state that persists, and its one home in the daily flow is the Screener verdict. Everything else the frame does is quiet: one authored motion moment, a 120–190ms budget, no entrance animations, no stagger, and a hard reduced-motion floor under all of it.

The repo-facing marks are part of the same system, not a separate identity: the favicon (`apps/client/public/favicon.svg`), the PWA icon set and maskable pair (`apps/client/public/icon-*.png`, `apple-touch-icon.png`), the manifest theming (`apps/client/public/manifest.webmanifest`), and the social card (`docs/brand/wicket-social-card.png`, built from `docs/brand/social-card.source.html`). All of them carry the postmark on aniline with bone strokes, and the card and README banner repeat the drawn left stile.

**Key Characteristics:**
- Two stocks (day bench, night frame) and four role inks; no third palette.
- Rank by inversion, never brightness, weight, or a coloured badge.
- Hairline joinery: compartments meet, they do not float or gap.
- One shadow in the whole system, for things that genuinely float.
- One type family at four widths, plus a machine face for measured values.
- State is struck across the item, and only where the state persists.

## Colors

Two stocks and four inks: a painted institutional ground with a small, jealously rationed set of role colours that each mean exactly one thing.

### Primary
- **Aniline Violet** (`{colors.aniline}`): the brand ink. The postmark, the drawn left stile, the focus ring, text selection, links and download affordances, the caret, and the small set of flat statements that carry it as a ground behind bone text — the Send button, the archive swipe reveal, the PWA update strip. In dark it lightens to `#a98cd9` for text and rules, with `#6b4aaf` as the flat ground.

### Secondary
- **Fluorescent Held** (`{colors.fluor}`): the Held verdict as a *tint* — the outline Held plate on the tray-label head, the Held gatekeeper badge, the search-offline notice. Darkened until it clears 4.5:1 on sunk stock.
- **Fluorescent Drench** (`{colors.fluor-flat}`): the same ink as a full ground, used only in the Screener bay and its entry banner. This is the single saturated surface in the product.

### Tertiary
- **Postal Red** (`{colors.postal}`): destructive and failed only — Blocked, Returned, Trash, a failed send, the Lifted rollback overprint, invalid recipients.
- **Phosphor Green** (`{colors.phosphor}`): confirmed only — Admitted, Sent.
- **Bone** (`{colors.bone}`): label stock. Text and glyphs sitting on a flat ink, never a page background.

### Neutral
- **Day Bench** (`{colors.frame}`): the frame itself, and the ground of inset fields. Body background in light.
- **Bench Plate** (`{colors.panel}`): the working surface — lists, panes, the pre-session plate, popovers.
- **Raised Plate** (`{colors.panel-2}`): hover stock, secondary control fill, pinned rows.
- **Sunk Plate** (`{colors.panel-sunk}`): recessed label-holder stock — every compartment head, day dividers, the app rail, chips, avatar plates.
- **Hairline Rule** (`{colors.rule}`): the soft divider inside a compartment (row to row).
- **Hard Rule** (`{colors.rule-hard}`): the structural divider between compartments, and every control border.
- **Ink** (`{colors.ink}`): primary text, and the inverted ground of any selected or primary control.
- **Ink 2** (`{colors.ink-2}`): secondary text, and anything sitting on sunk stock (`ink-3` does not clear contrast there).
- **Ink 3** (`{colors.ink-3}`): tertiary text on panel stock — snippets, timestamps, read rows, placeholders.

Dark inverts the stocks to warm hardwood (`#1a1611` frame through `#38312a` sunk) with bone ink (`#ede7da`), and lifts the role inks (`#ff7a3c`, `#f2685e`, `#5cc98a`). Bare `:root` is the light set, so nothing depends on a media query having matched; `@media (prefers-color-scheme: dark) :root:not(.light)` and `:root.dark` carry the dark set, so an explicit choice always wins.

### Named Rules
**The Four Inks Rule.** Aniline, fluorescent, postal, phosphor. Each appears only for its own job — brand/focus, held, destructive/failed, confirmed. A new state does not get a new colour; it gets one of these four or none.

**The Rank-By-Inversion Rule.** Rank is inversion, never brightness. A selected row, an active toggle, a primary button take `{colors.ink}` as ground and `{colors.frame}` as text. Controls take no ink colour: relief and rule only.

**The One Drenched Room Rule.** `{colors.fluor-flat}` as a ground belongs to the Screener and its entry banner and nowhere else. The tray-label head carries the outline Held plate; the bay carries the solid statement. Two fluorescent statements on one screen is a defect, not emphasis.

**The Sunk Stock Contrast Rule.** Anything set on `{colors.panel-sunk}` takes `{colors.ink-2}` or darker. `{colors.ink-3}` measures 3.8:1 there and is reserved for panel stock.

## Typography

**Display / Body Font:** Archivo Variable (with Helvetica Neue, Arial, sans-serif)
**Label/Mono Font:** Martian Mono Variable (with ui-monospace, SFMono-Regular, Menlo, monospace)

Both are self-hosted from the app's own origin via `@fontsource-variable`, using the `standard.css` slice because it carries the **width** axis as well as weight. A client whose promise is that you own your server does not fetch fonts from a CDN on cold start.

**Character:** One grotesque set at four widths does the whole job — the type program is a rack of label stocks, not a font pairing. Narrow, tracked, uppercase Archivo is the printed label; the wide cut is signage; the machine face is anything a machine measured.

### Hierarchy
- **Display** (800, 21–27px, width 118%, uppercase, -0.02em): the wordmark only — the pre-session plate at 27px, the app rail at 16px, the bay sign.
- **Headline** (700, 21px, width 96%, -0.012em, `text-wrap: balance`): the Thread subject in detail view.
- **Title** (700, 15–17px, width 92–96%): the pre-session form heading, the Screener sender name, settings sub-heads.
- **Sender** (600–660, 12.5–13px, width 92%): the sender column in the timetable and the per-Message header. Its own width step so a column of names sets tighter than running text.
- **Body** (400, 13–14px, 1.5–1.6): running UI text. Body copy caps at 46–74ch depending on compartment; the Thread snippet at 70ch, settings prose at 68ch.
- **Label** (600–720, 9–11.5px, width 78%, 0.10–0.14em, uppercase): every control, compartment head, chip, legend, and empty-state line. This is the most common type in the app.
- **Machine** (Martian Mono, 9–11px): timestamps, email addresses, byte sizes, counts, the Index Watermark, keyboard keys, cutoffs. Tabular figures are on for `time` and `.tabular`.
- **Strike** (800, 20px, width 70%, 0.16em, uppercase, 2.5px rule, tilted -5deg): the struck verdict. The inline `.overprint` cut is the same voice at 9.5px / width 74% / 1.5px rule / -3deg.

### Named Rules
**The Width-Axis Rule.** Hierarchy is carried by the width axis before size or weight. Label 78%, sender 92%, running text 100%, display 118%. Never substitute a non-variable fallback face and never simulate the narrow cut with letter-spacing alone.

**The Machine Face Rule.** Anything a machine measured or generated — a timestamp, an address, a byte count, a key cap, an index-coverage watermark — is set in Martian Mono. Anything a person wrote is set in Archivo.

**The Tracked Label Rule.** Uppercase always comes with the narrow width and 0.10em+ tracking. Uppercase at 100% width with normal tracking is not part of this system.

## Layout

The app is one frame filling the viewport, and the shell owns it: `.app-shell` is `100dvh` with `overflow: hidden`, never `min-height`/`100vh`, so the document itself never scrolls at any width. Whichever route is current (Mail, Settings, or a placeholder App — `router/routes.tsx`) renders into `.app-viewport`, a bounded pane below the header rail; each route's own top-level element is itself `height: 100%; min-height: 0` and scrolls independently. A drawn 3px aniline **stile** is fixed to the left edge of the shell and the pre-session frame as a structural member (not a border), and every level of the app registers to it via a matching 3px left inset. The same edge appears on the social card and the README banner.

Compartments divide on hairline rules that meet at the corners: `{colors.rule-hard}` between compartments and around controls, `{colors.rule}` between rows inside one. Nothing gaps, nothing rounds away from its neighbour, nothing casts a shadow onto the frame.

**Spacing rhythm.** Control padding runs 4–7px vertical / 6–12px horizontal; compartment padding is 7–13px on heads and 16–22px on bodies; settings compartments use 18px with a 16px × 26px wrapping field run. `env(safe-area-inset-*)` is added unconditionally to every edge-touching pad rather than gated behind a standalone media query.

**Row geometry is load-bearing.** 60px default row, 40px compact row, 32px day divider. These match `ROW_HEIGHT`, `COMPACT_ROW_HEIGHT` and `HEADER_HEIGHT` in `VirtualizedThreadList.tsx`; changing either side alone breaks virtualisation.

**Responsive.** The split list is `clamp(360px, 36%, 620px)`, widening to `clamp(548px, 41%, 680px)` past 1100px so the single-line timetable actually renders at desktop. Below 700px the split collapses to one pane at a time (both panes stay mounted, one is hidden, so keyboard triage and in-flight swipes survive), the tray-label head wraps to two rows with icon-only controls, and the sender column narrows to 104px. The row fold is a **container** query, not a media query: at `≤520px` of list width the row becomes a two-line grid (plate spanning both rows, sender + time on line one, subject on line two) and finally uses the 60px it already occupied.

**Density and layout mode are Device Preferences.** They are stored per device and never sync.

### Named Rules
**The Joinery Rule.** Compartments are divided, not spaced. No card, no gap, no drop shadow between two parts of the frame. If two regions need separating, they get a hairline rule that meets the corners.

**The Pinned Geometry Rule.** 60 / 40 / 32 are contract values shared with `VirtualizedThreadList.tsx`. Change them in both places or not at all.

## Elevation & Depth

The frame is flat. Depth is tonal — four steps of stock (`frame` → `panel` → `panel-2` → `panel-sunk`) plus hairline rules — and rank is inversion. There is exactly **one** shadow token, and it belongs only to things that genuinely float above the frame.

### Shadow Vocabulary
- **Lift** (`box-shadow: var(--w-lift)` = `0 10px 30px -10px rgb(31 29 24 / 0.38), 0 2px 4px -2px rgb(31 29 24 / 0.24)`; in dark `0 12px 34px -10px rgb(0 0 0 / 0.66), 0 2px 6px -2px rgb(0 0 0 / 0.5)`): popovers, dialogs, the label picker, search history, the composer and its menus, toasts, the pending-send bar.
- **Grommet** (`box-shadow: inset 3px 0 0 -1px var(--w-rule-hard)`): the pinned Thread only. A pinned item sits proud of the stock; it is never tinted to mark it.

### Named Rules
**The One Shadow Rule.** If it is part of the frame, it has no shadow. If it floats over the frame, it takes `--w-lift` — the same value, never a softer or harder variant.

## Shapes

Corners are square by intent: 2px on plates and controls (`{rounded.plate}` — metal label holders have square corners) and 1px on bands and chips (`{rounded.band}`). Every Tailwind radius step from `md` up is mapped to the same 2px, so a `rounded-2xl` utility cannot smuggle in a soft corner. Borders are 1px hairlines (`{rounded.hair}`) at `{colors.rule-hard}`; 1.5px is the heavier cut used on inverted controls, overprints and outline statements; 2.5px is the strike's own rule.

The correspondent mark is a **square plate**, 26px (20px compact), sunk stock with a hard rule, carrying initials drawn from the address — never a circle and never a fetched image, because remote images are blocked until a sender is Approved.

The signature silhouette is the **postmark**: a circular date stamp broken at the lower left (the wicket you pass through single file) with killer bars trailing off to the right. Geometry is fixed: `r=32` at `cx=44 cy=64`, 8.5 stroke, `stroke-dasharray="161 40"` rotated 171deg so the break sits lower-left, bars at `x=72 w=48 h=8.5`. Three bars at ≥26px, two below (the favicon ships the two-bar cut). Bars trail the ring and never cross it — crossed, the mark reads as a currency glyph.

Pictograms are a single authored set on one 24 grid, **solid fills, no strokes**: signage, not hairline icons. A tray for Archive, a grommet for Pin, a barred disc for Block. Type-formatting controls are set in the brand face as letterforms (B / I / U / S) rather than drawn.

## Components

### Buttons
- **Shape:** square-cornered plates (2px), 1px hard rule, or 1.5px on inverted primaries.
- **Primary:** inverts the stock — `{colors.ink}` ground, `{colors.frame}` text, label type, 6px × 12px. Hover goes to `{colors.ink-2}`. Compose, Admit, the pre-session submit, active toggles and segmented items all use this.
- **Secondary / Ghost:** `{colors.panel-2}` on hard rule with `{colors.ink-2}` text; hover fills to `{colors.panel-sunk}` and darkens text to `{colors.ink}`. Alternate routes (passkey login, Back) drop to transparent on the same rule.
- **Destructive:** stays outline, `{colors.postal}` text on a neutral rule, and takes a deliberate `22px` left margin (14px in the Screener) to put distance between it and the button beside it. Hover borders in postal and fills at 12% postal.
- **Held:** outline in `{colors.fluor}` at 1.5px, hover at 16% `fluor-flat`. The one place fluorescent reaches the triage screen.
- **Press:** every button in the mail frame answers with `transform: scale(0.97)` over 120ms. A physical control that answers nothing feels broken.

### Chips
- **Style:** 1px band radius, sunk stock, hard rule, label type at 9–9.5px. Labels, folder pills, search scopes, recipient chips (machine face).
- **State:** a toggled search chip inverts (`ink` ground). A seeded scope chip goes dashed and `{colors.ink-3}`. Inside a selected row, every chip drops to transparent with a `frame`-tinted rule.
- A Label chip is a **bundle band**: the tint goes the whole way round the chip. Never a stripe down one edge.

### Cards / Containers
There are no cards. The container is a **plate**: a compartment with a sunk head (`{colors.panel-sunk}`, label type, hairline bottom rule) over a `{colors.panel}` body, bounded by hard rules, radius 2px, no shadow. The pre-session plate is the canonical cut — 420px max width, head at 22px × 26px, body at 24px × 26px.

### Inputs / Fields
- **Style:** inset — `{colors.frame}` ground (a step *below* the plate it sits on), 1px hard rule, 2px radius, 9px × 11px, 13–14px body type.
- **Hover:** rule darkens to `{colors.ink-3}`. **Focus:** rule takes `{colors.aniline}`; the global `:focus-visible` outline is 2px aniline at 1px offset, and the caret is aniline.
- **Field label:** stacked above the control, label type at 10px / width 78% / 0.11em uppercase in `{colors.ink-3}` — a routing slip, legend over value. A checkbox is the exception: control first, sentence-case words after.
- **Checkbox:** a 16px punched box, band radius, that fills with `{colors.ink}` and takes a drawn tick in frame colour. No accent colour.
- **Select:** UA appearance removed; the chevron is two drawn strokes in `{colors.ink-2}`, never a system glyph.
- **Error:** `role="alert"` block at 12% postal over panel, 45% postal rule, text mixed 74% postal into ink.

### Navigation
The app rail is a sunk plate (9px × 14px, hairline bottom rule) carrying the wordmark at 16px, the signed-in user in label type, a role band tinted 16% aniline, and an outline sign-out that takes no ink until reached for. In-frame navigation is the **segmented control**: a run of compartments divided by hairlines inside one 2px plate with `overflow: hidden`, where the active segment inverts. It goes 50% opacity when the view it controls is not in play. Below 700px the head wraps to two rows and its controls become icon-only (`font-size: 0` collapses the text nodes; the Held plate keeps its count via `::after`).

### The Timetable Row (signature)
A 60px single-line row on panel stock with a hairline bottom rule: square correspondent plate, 148px sender column, subject with an `{colors.ink-3}` snippet trailing it, label bands, and a right-aligned tabular monospace time. Hover raises to `{colors.panel-2}`; selection inverts to ink and softens its own secondary text via `color-mix` toward frame; a read Thread drops sender and subject to `{colors.ink-3}` (a read row steps back, an unread row never steps forward in weight); a pinned Thread takes raised stock plus the grommet inset. No entrance animation and no stagger: a list that reflows hundreds of times a session must never animate its own arrival. Touch adds a swipe reveal — the tray the item is dropped into — aniline for Archive on the left, postal for Trash on the right, bone label type.

### The Strike (signature)
`.strike` prints `data-strike` across the centre of the item: uppercase, width 70%, weight 800, 0.16em tracked, ruled at 2.5px, tilted -5deg, blended into the stock beneath it (`multiply` in light, `plus-lighter` in dark). Two settings: **wet** at 0.4 opacity (light: 0.32 dark) while the Sync Backend has not answered, and **set** at 0.84 (0.76 dark) once confirmed; on rollback the ink lifts. `.overprint` is the inline, badge-sized cut of the same voice, in fluor (held), postal (blocked/failed), aniline (done) or phosphor (admitted).

Where it appears: a search result already acted on, a held or blocked sender, a failed send (`NOT SENT` in postal), the rollback toast (`LIFTED`), and — its one home in the daily flow — the Screener verdict, where the decided slip is replayed for 900ms after the write, struck in the bay's own near-black, then cleared over 190ms. It never appears on a triage keystroke: `store/reads.ts` drops an archived Thread the instant the mutation is queued, and holding that row open to show ink would tax the one thing that must stay snap-instant.

### The Screener (signature)
The one drenched room: a full `{colors.fluor-flat}` ground with `#1f1d18` ink, its own near-black rules at 24–50% alpha, and focus outlines in the same near-black. One facing slip per Unscreened Sender — never one per message — with the sender block at 210px, a peek line, and three verdict controls: Admit inverts to near-black on bone, Return and Block stay outline, and Block keeps a 14px distance. The bay closes on its own stated rule rather than empty ground.

### Toasts
Ink ground, frame text, 2px radius, `--w-lift`, entering with `toast-enter` (8px rise + fade, 150ms, `--w-ease-strike`). Rollback toasts lead with the `LIFTED` overprint in postal; new-mail toasts stack top-right at 320px max.

### Motion
The whole budget: `--w-dur-press` 120ms (presses, colour and border changes, linear), `--w-dur-fast` 150ms (toast entry, opacity, disclosure rotation, `--w-ease` `cubic-bezier(0.25, 1, 0.5, 1)`), `--w-dur-strike` 190ms (the strike's clear, `--w-ease-strike` `cubic-bezier(0.16, 0.9, 0.12, 1)`). Nothing animates height. `prefers-reduced-motion: reduce` clamps every animation and transition in the app to 1ms.

### shadcn primitives (installed, not yet adopted)
`src/components/ui/` carries button, select, dialog, dropdown-menu and tooltip. Every colour and corner they render is mapped onto Wicket tokens through the shadcn token surface in `index.css` (`--primary` → aniline-flat, `--destructive` → postal, `--border`/`--input` → rule-hard, `--ring` → aniline, `--radius` → 2px). **No screen adopts them yet.** Their internal glyphs are Lucide hairline icons; `lucide-react` remains a dependency for that reason alone. The first screen to adopt one must swap its glyph for the matching `Pictogram` name, so the app never puts a hairline outline icon beside a solid one.

## Do's and Don'ts

### Do:
- **Do** rank by inversion: ink ground, frame text, on the selected row, the active toggle, and the primary button.
- **Do** divide compartments with hairline rules that meet at the corners (`{colors.rule-hard}` between compartments, `{colors.rule}` between rows).
- **Do** carry hierarchy on the width axis first — label 78%, sender 92%, text 100%, display 118%.
- **Do** set every machine-measured value (time, address, byte size, count, key cap) in Martian Mono with tabular figures.
- **Do** put anything sitting on sunk stock in `{colors.ink-2}` or darker.
- **Do** give destructive actions physical distance (22px in the frame, 14px in the bay) and leave them outline until reached for.
- **Do** use the authored `Pictogram` set for every glyph the app renders, solid fill on the 24 grid.
- **Do** use CONTEXT.md's vocabulary verbatim in UI copy: **Thread** not conversation, **Mail Account** not mailbox, **Screener** not quarantine or spam folder, **Verdict** as Unscreened / Approved / Blocked. **Star** and **Pin** are different features and their words are not interchangeable.
- **Do** keep `env(safe-area-inset-*)` in every edge-touching pad.
- **Do** self-host faces from the app's own origin.

### Don't:
- **Don't** put a card, a gap, or a drop shadow between two parts of the frame. `--w-lift` is only for things that genuinely float.
- **Don't** give a control an ink colour. Controls take relief and rule; colour belongs to state.
- **Don't** use `{colors.fluor-flat}` as a ground anywhere but the Screener and its entry banner — one fluorescent statement per screen.
- **Don't** invent a fifth role ink, or reuse an existing one for a state it does not name.
- **Don't** strike a triage keystroke, or any state that does not persist. The strike belongs to decided, durable state.
- **Don't** mark unread with bold or a coloured dot; the read row steps back in tone instead.
- **Don't** stripe a Label down one edge of a row — a Label is a band, tinted the whole way round.
- **Don't** animate a list's arrival, stagger rows, or transition height.
- **Don't** round past 2px, or reach for a Tailwind radius utility expecting a soft corner.
- **Don't** fetch a correspondent's image or a font from a CDN; marks are drawn from the address and faces are self-hosted.
- **Don't** mix hairline outline glyphs with the solid set — including inside an adopted shadcn primitive.
- **Don't** restyle a message body. It is third-party HTML in a sandboxed iframe and the design system stops at that boundary.
