# Polish pass: "Minimal, but purposeful"

Refinement of The Instrument (`apps/client/DESIGN.md`), not a redesign. The palette, the one accent,
ground-and-gap, the taper, the Hub and the App Switcher all stay. What changes is everything that
currently reads as accidental: the phone chrome, the dock, the control vocabulary, the spacing scale,
the type scale, the motion budget, and the Tasks App's shape.

Visitor mode: **Operate**. Register unchanged: Linear / Arc / Superhuman, calm on first open, expert
underneath.

## Diagnosis (why it feels accidental)

1. **The phone chrome frames instead of floats.** `.app-viewport` reserves the header's and dock's
   height as padding, so content stops above the dock and a strip of ground shows beneath it (the
   "gray bar"). The header is an opaque `surface-strong` slab with a relief shadow. Neither is over
   the content; both are around it.
2. **The dock has four voices in one pill.** Ghost icon-over-caption tiles, a bordered `surface`
   switcher tile with a chevron and a variable-width label, a 10.5px caption size that exists
   nowhere else, and a grammar (two controls either side of a centred switcher) that only
   composes when an App declares exactly two controls. Four Apps declare one.
3. **Three button dialects.** Solid accent pill (Compose), hairline-bordered pill on `surface`
   (Contacts "New contact", Calendar "Today"), ghost pill (Calendar view switcher, Contacts tabs
   with a hairline underline). Filters and buttons share the pill shape so nothing tells them
   apart. Calendar's prev/next are the text glyphs `‹ ›`. Tasks' List/Board is a bare `<select>`.
4. **Hairlines leaked out of Settings.** `.calendar-toolbar`, `.contacts-app-tabs`,
   `.tasks-split-list`, `.tasks-quick-add`, `.draft-row`, the Sheet's `border-t`. DESIGN.md says the
   hairline lives in Settings only.
5. **Martian Mono is the "typewriter font".** It sets timestamps, counts, byte sizes, keycaps,
   and, past its brief, whole email addresses (`.screener-row-address`, `.screener-view-address`,
   `.sender-contact-card-address`) and the Gatekeeper cutoff. A wide mono at 11px beside Inter
   reads as a second, unrelated voice.
6. **No shared scale.** Font sizes in use: 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15,
   16, 21. Paddings: 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 17, 18, 20. Every App picked its own.
7. **Motion is missing where it would explain.** Bottom sheets fade and slide only 2.5rem with
   `ease-in-out`. Phone list to detail is a hard `display: none` swap. Segments snap. Only Mail
   rows and Stream cards have authored motion.
8. **Tasks is a different product.** A hairline-divided sidebar with always-visible pencil and
   trash icons per row, a "Pick a Task List." landing state, a `<select>` for view mode, a
   bordered quick-add form, and on phone a sidebar screen you must "back" out of. Nothing mirrors
   Mail's rail, group headers, or reserved-whitespace actions.

## Direction: five rules (become DESIGN.md rules at the end)

**R1. Chrome floats over content; content never stops for chrome.** On phone, header and dock are
translucent, blurred, and sit on top of the scrolling pane. Every scroller pads its own top and
bottom by the chrome's height so the first and last rows can scroll clear. No slab, no reserved
strip, no shadow on the header.

**R2. Shape names the category.** Pill (`--radius-pill`) is reserved for the one primary action and
the search entry. Chips (filters, tags, facets) are `--radius-sm` on `--color-field`, selected =
`--color-accent-soft` + accent ink. Every other control is `--radius-md` ghost. Segments (pick one
view) are ghost `--radius-md` options inside a `--color-field` track with a sliding
`--color-surface` thumb. No hairline-bordered buttons anywhere.

**R3. One primary action per App, in one place.** Each App declares exactly one primary action
(Compose, New contact, New event, New task, New note). It renders as the solid accent pill in the
global header on desktop and as the dock's trailing tile on phone. Nothing else on screen is solid
accent.

**R4. One scale.** Type: 11.5 (label), 13 (secondary), 14 (body), 17 (pane title), 21 (heading).
Space: 4, 8, 12, 16, 20, 24, 32. Control heights: 28 (inline icon), 32 (toolbar), 38 (primary),
44 (touch tile). Any other value is a defect unless `mail/taper.ts` owns it.

**R5. Motion explains a change of place or state, once.** Sheets rise from the bottom edge
(`--dur-leave`, `--ease-out`) behind a fading scrim. On phone, a detail pane pushes in from the
right (`--dur-fast`). A segment thumb slides. A press scales to 0.97. Nothing else animates in;
Arrive-Silent, Leave-Visibly still governs lists.

## Resolved details

### Phone chrome (R1)

- `.app-shell` declares `--chrome-top: calc(52px + env(safe-area-inset-top))` and
  `--chrome-bottom: calc(52px + 12px + env(safe-area-inset-bottom))` below 768px, both `0px` at
  or above it.
- `.app-viewport` phone padding: none. Its ground is `--color-bg` (already).
- Header (phone): height 52px, `position: fixed`, background
  `color-mix(in srgb, var(--color-bg) 78%, transparent)`, `backdrop-filter: blur(18px)
  saturate(1.3)` with `-webkit-` prefix, no `box-shadow`, no border. Contents unchanged (search
  entry, Account Scope, avatar). Search entry height 36px.
- Every phone scroller takes `padding-top: var(--chrome-top)` and `padding-bottom:
  var(--chrome-bottom)` plus matching `scroll-padding-top/bottom`. Known scrollers:
  `.thread-list`, `.split-pane` reading scroller, `.screener`, `.drafts-view`, Stream's stack,
  `.settings-shell`/`.settings-page`, `.tasks-split-list`, `.tasks-main`, the Contacts grid
  section, the Notes grid, the Calendar toolbar + grid, Recently Deleted screens, the search
  results view, `.app-placeholder`. Panes that already own a fixed header row inside them
  (`.reading-header`, `.calendar-toolbar`) take the top inset on that row instead.
- Retract on scroll stays a pure transform. Delete the `[data-chrome-hidden] .app-viewport`
  padding-collapse rules; they exist only because content stopped for chrome.
- `theme-color` tracks the ground the chrome now blends into: below 768px `--color-bg`
  (`#fbfbfc` / `#0c0d10`), at or above it `--color-surface-strong` as today. Both
  `device-theme.ts` and the pre-paint script resolve width with `matchMedia("(max-width: 767px)")`;
  tests updated.
- **The Android bar that stays light (reported: Android Chrome installed PWA; Edge on Windows
  PWA works).** An installed WebAPK paints its status bar from the manifest's `theme_color` and
  can ignore a later change to the `theme-color` meta, while a desktop PWA follows the meta.
  Ticket 4 therefore ships two steps: (1) the width-aware meta above; (2) remove `theme_color`
  from `manifest.webmanifest` so Chrome has only the page's meta to follow (the splash keeps
  `background_color`), and retire the test that pins the manifest colour. The user verifies on
  their Android device after each step; the PR records which step fixed it.

### Dock (R1, R3)

- Grammar: `[switcher] [App controls…]`, leading switcher, then the App's declared controls in
  order, at most two. One control yields a two-tile pill; two yield three. The pill hugs its
  tiles; it is never stretched.
- Tiles: 44×44, `--radius-pill`, icon only (`size={20}`), `aria-label` carries the full name.
  No captions.
- Switcher tile: the current App's icon inside a 28px `--radius-md` square on
  `--color-accent-soft` with accent ink. No chevron, no App name. Opens the same `PhoneSwitcher`
  Sheet.
- Pill: padding 4px, gap 2px, background `color-mix(in srgb, var(--color-surface) 72%,
  transparent)`, `backdrop-filter: blur(20px) saturate(1.4)`, `box-shadow: var(--shadow-overlay),
  inset 0 0 0 0.5px color-mix(in srgb, var(--color-ink) 8%, transparent)`.
- Press: tile `scale(0.9)` over `--dur-press`, icon colour to accent. Compose keeps the 90° plus
  turn.
- Registry: `apps.ts#AppDef.dockControls` becomes `AppDef.primaryAction` (one
  `{ key, label, icon }`) plus `AppDef.navControl?` (Folders for Mail, Calendars for Calendar,
  Lists for Tasks; none for Contacts and Notes). Dock renders `[switcher][nav?][primary]`.

### Control vocabulary (R2)

New `apps/client/src/controls.css`, imported from `index.css`:

- `.btn-primary`: 38px, `--radius-pill`, solid accent, weight 600, 14px, padding 0 18px,
  `transform: scale(0.97)` on `:active`, hover `filter: brightness(1.06)`.
- `.btn-ghost`: 32px (or 28px with `.btn-ghost--sm`), `--radius-md`, transparent, ink-muted;
  hover `--color-hover` + ink; `[aria-pressed="true"]`/`.current` = accent-soft + accent.
  `.btn-icon` modifier makes it square.
- `.segmented`: `--color-field` track, `--radius-md`, 32px; options are ghost text 13px weight
  550; the current option gets a `--color-surface` thumb (`::before` on the track positioned via
  `--seg-index`/`--seg-count` custom properties set inline, transition `transform --dur-fast
  --ease-out`). Implemented once as `components/Segmented.tsx` (a11y: `role="radiogroup"`).
- `.chip`: 24px, `--radius-sm`, `--color-field`, 11.5px weight 600 ink-muted; `[aria-pressed=
  "true"]` = accent-soft + accent ink. Removable chips carry an `X` icon button inside.
- Migrations: `.contacts-new-link` → primary pill moved to the header (R3);
  `.calendar-today-btn` → `.btn-ghost`; `.calendar-view-switcher-*` → `Segmented`;
  `.contacts-app-tabs` → `Segmented` (drop the hairline); `.tasks-mode-field` `<select>` →
  `Segmented`; `.address-book-filter`, `.notes-label-filter`, `.search-chip`, `.tasks-search-chip`,
  `.label-chip` → `.chip`; `.calendar-icon-btn`, `.reading-back`, `.tasks-back`,
  `.header-icon-btn` → `.btn-ghost.btn-icon`; Calendar `‹ ›` → `ChevronLeft`/`ChevronRight`.
- Hairline removals outside Settings: `.calendar-toolbar`, `.contacts-app-tabs`,
  `.tasks-split-list`, `.tasks-quick-add`, `.draft-row` (finish its deferred `.thread-row`
  treatment), Sheet bottom `border-t`.

### Primary action placement (R3)

- `RootLayout` header-right, before Account Scope, renders `<PrimaryAction app={currentApp}>`
  on desktop: `.btn-primary` with the App's icon and label. Handlers move out of `Dock.tsx` into
  `apps/primary-action.ts#usePrimaryAction(appKey)` so the header and the dock share one
  implementation. Mail: Compose (via `ActionContext.onCompose`, fallback navigates to Mail).
- Mail's rail `.compose-btn` is removed (the header carries it; `c` still composes).
- Tasks "New task" focuses the quick-add of the current view (Today when none) instead of
  navigating; Notes "New note" keeps minting and opening a Note.

### Type and space (R4)

- `@mail/design-tokens` gains `space` (4…32) emitted as `--space-1…--space-8` and a `text`
  ladder (`--text-label: 11.5px`, `--text-secondary: 13px`, `--text-body: 14px`, `--text-title:
  17px`, `--text-heading: 21px`). Regenerate `tokens.css`.
- Sweep `contacts.css`, `notes.css`, `tasks.css`, `calendar.css`, `shell.css`, `settings.css`
  for off-scale font sizes and paddings; snap each to the ladder. `mail.css` row/header geometry
  owned by `taper.ts` is exempt; everything else in `mail.css` is in scope.
- Pane title tier: 17px / 620 / -0.01em, used by Tasks, Contacts, Notes, Calendar, Settings
  page headers. The Reader's subject keeps 21px as the only heading.
- Pane padding: 20px desktop, 16px phone. Space above a pane title: 20px; below: 12px.

### Machine values (decided: retire Martian Mono)

Remove the Martian Mono import and `--font-mono`'s face; machine values set in Inter
with `font-variant-numeric: tabular-nums`, 11.5–12px, ink-faint. Email addresses set in Inter 13px
ink-muted. Keycaps: Inter 11.5px weight 600 on `--color-field`, `--radius-sm`. The SMTP rejection
text keeps `ui-monospace` (it is code). DESIGN.md `typography.machine` becomes an Inter tabular
tier.

### Motion (R5)

- `components/ui/sheet.tsx` bottom variant: enter `translateY(100%) → 0` over `--dur-leave`
  `--ease-out`, exit reverse over `--dur-fast`; scrim `bg-black/20` fading over `--dur-fast`;
  remove `border-t`; top radius `--radius-panel`. `tw-animate-css` slide utilities are replaced
  by two keyframes in `shell.css`.
- Phone detail push: `.split-view.has-selection .split-pane`, `.tasks-split-view.has-selection
  .tasks-split-pane`, and Contacts' equivalent play `pane-enter` (`translateX(24px)` + opacity
  0 → 1, `--dur-fast`, `--ease-out`) on mount. One keyframe, in `shell.css`.
- Task complete: the check draws (`stroke-dashoffset`) over `--dur-fast` before the row leaves.
- All clamped by the existing `prefers-reduced-motion` rule.

### Tasks (R2–R5 applied)

- Rail (`TasksSidebar`) adopts Mail's `.side-nav` / `.nav-item` idiom (`mail/Sidebar.tsx`,
  `mail.css`): ghost rows at `--radius-row`, `.nav-label` + `.nav-count.tabular`, current =
  accent-soft, no right hairline; a label-tier caption "Lists" above the Task Lists; rename /
  delete move to a right-click `ContextMenu` plus a hover/focus-revealed `…` button in a reserved
  24px gutter (the ThreadRow pattern), never always-visible. "New list" is a ghost row with a
  plus icon at the foot of the lists; "Recently deleted" is a quiet ghost row below it.
- Landing: `/tasks` with no `list`/`view` shows Today on every width. "Pick a Task List." is gone.
- On phone the rail is a bottom Sheet opened by the dock's Lists tile (the Folders pattern), so
  the main pane is always the screen.
- Main pane header: back (phone only, `.btn-ghost.btn-icon`), title at the pane-title tier,
  `Segmented` List/Board at the right.
- Quick add: a ghost row "+ Add a task" at the top of the list, `--color-field` only while
  focused, no border. The primary action focuses it.
- Completed: a group header in Mail's `.group-header` idiom (label + tabular count), collapsible,
  replacing `<details>`.
- Board columns: ground-and-gap (`--color-surface` columns on `--color-bg`), no hairlines.

## Tickets

Every ticket: fresh context, `pnpm typecheck` + `pnpm --filter @mail/client test` green, biome
clean, one Conventional Commit, and a device checklist in the PR body for what the worker cannot
see. Workers run the mechanical detector over their changed files once at the end:
`node .claude/skills/impeccable/scripts/detect.mjs --json <files>` from the repo root.

| # | Ticket | Files (centre) | After | Model |
|---|--------|----------------|-------|-------|
| 1 | Tokens: space and text ladders in `@mail/design-tokens`; regenerate `tokens.css`; document in the package README | `packages/design-tokens/src/*`, `dist` rebuild | — | sonnet·medium |
| 2 | `controls.css` + `Segmented.tsx`: `.btn-primary`, `.btn-ghost(.btn-icon)`, `.segmented`, `.chip`; migrate Calendar, Contacts, Notes, Mail chips and back buttons; Lucide chevrons; hairline removals listed above | `src/controls.css`, `components/Segmented.tsx`, `calendar.css`, `contacts.css`, `notes.css`, `mail.css` chips | 1 | sonnet·medium |
| 3 | Retire Martian Mono; machine tier in Inter tabular; keycaps on a field chip; addresses back to Inter | `index.css`, `mail.css` (17 sites), `compose.css` (4), `settings.css` (2), DESIGN.md typography | 1 | sonnet·medium |
| 4 | Full-bleed phone chrome: `--chrome-top/bottom`, translucent blurred header, scroller insets, retract cleanup, width-aware `theme-color`, manifest `theme_color` removal as step 2 | `shell.css`, `RootLayout.tsx`, `device-theme.ts`, `pre-paint.ts`, `index.html`, every phone scroller listed | 1 | sonnet·high |
| 5 | Dock redesign: leading icon-only switcher tile, `primaryAction` + `navControl` registry, Calendars and Lists nav controls, blurred pill | `Dock.tsx`, `apps.ts`, `AppSwitcher.tsx` (dock variant), `shell.css` dock rules, `apps.test.ts` | 4 | sonnet·medium |
| 6 | Primary action in the desktop header; `usePrimaryAction` shared with the dock; remove rail Compose | `RootLayout.tsx`, `apps/primary-action.ts`, `Dock.tsx`, `mail/Sidebar.tsx`, `shell.css` | 2, 5 | sonnet·medium |
| 7 | Motion: Sheet rise, phone pane push, segment thumb, task check draw | `components/ui/sheet.tsx`, `shell.css`, `mail.css`, `tasks.css`, `contacts.css` | 2, 4 | sonnet·medium |
| 8a | Tasks rail + landing + phone Lists sheet | `TasksSidebar.tsx`, `TasksApp.tsx`, `TasksRoute.tsx`, `routes.tsx` (tasks search defaults), `tasks.css`, tests | 2, 5 | sonnet·high |
| 8b | Tasks main pane: toolbar, Segmented, quick-add row, completed group header, board ground-and-gap, primary action focuses quick add | `TaskListView.tsx`, `TaskTodayView.tsx`, `TaskUpcomingView.tsx`, `TaskQuickAdd.tsx`, `TaskBoardView.tsx`, `tasks.css`, tests | 6, 8a | sonnet·high |
| 9 | Scale sweep: snap every off-ladder size and padding in `contacts.css`, `notes.css`, `calendar.css`, `settings.css`, `shell.css`, non-taper `mail.css`; pane title tier; PWA banner to sentence case | those files | 2, 3, 4 | sonnet·medium |
| 10 | Finish: detector over all changed files, `impeccable-finish-reviewer`, fix list, `impeccable-documenter` regenerates DESIGN.md with R1–R5 | — | all | opus (this session) |

Waves: **W1** = 1, 2, 3, 4 · **W2** = 5, 6, 7, 8a · **W3** = 8b, 9 · **W4** = 10.

Process: a docs branch carries this spec (`docs/design/polish-pass.md`); one GitHub epic per wave
naming the shared trunk `feat/polish-pass`, cut from the docs branch; each ticket a sub-issue
labelled `ready-for-agent`. Workers are Sonnet subagents in their own worktrees, medium effort,
high where the table says so; merges land on trunk after the gate (`pnpm typecheck && pnpm
--filter @mail/client test`), and the trunk PR carries the device checklist you run on your phone.

## Decisions (taken 2026-09-15)

- **A. Martian Mono:** retired entirely. Inter tabular carries every machine value; only the
  verbatim SMTP rejection keeps a system mono.
- **B. Dock grammar:** leading switcher tile, icon-only tiles, no captions, no chevron.
- **C. Desktop primary action:** App-aware accent pill in the global header; Mail's rail Compose
  button is removed (`c` still composes).
- **D. Theme bar:** seen on Android Chrome installed PWA; Edge on Windows PWA is fine. Handled in
  ticket 4 as described under Phone chrome.
