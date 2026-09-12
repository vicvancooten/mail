# @mail/design-tokens

The Instrument's design tokens — colour, type and geometry — as plain
TypeScript, so a future native Client can import the same values a web
Client consumes as CSS.

- `.` exports the tokens themselves (`lightColors`, `darkColors`, `radii`,
  `fonts`, …) and `buildTokensCss()`, the pure function that renders them to
  CSS custom properties.
- `./css` exports the generated stylesheet (`dist/tokens.css`, built by
  `pnpm build`) that the Client's `apps/client/src/index.css` imports ahead
  of its `@theme inline` block. No token value is duplicated there — every
  Tailwind/shadcn variable maps onto one of these custom properties.

Selectors match the rest of the Client's theming: `:root` carries light
values, an OS dark preference wins under `@media (prefers-color-scheme:
dark)` guarded by `:not(.light)`, and an explicit `.dark` class wins
outright — so wiring a toggle to `documentElement.classList` is a drop-in.

## Breakpoints

- `phoneBreakpoint` (768px) — the Client's one phone breakpoint (#273):
  every phone-detecting hook and CSS media query reads this same number.
- `splitMinimum` (920px, #296) — the width below which Mail's Split view
  falls back to list-then-Reader rather than showing both panes squeezed
  past readability. Derived, not picked: `splitListMinimumWidth` (280px,
  `mail.css`'s own `.split-list` floor) plus `splitReaderReadableWidth`
  (640px, a Reader narrow enough to still read comfortably). Read by
  `apps/client/src/hooks/use-split-minimum-width.ts` for the render seam
  that swaps `SplitView` for `ListView` (`mail/MailSection.tsx`) and
  declared as `--split-minimum` in the generated `tokens.css` for CSS
  authors — the fallback is a component swap, not a Split-internal layout
  rule, so no media query currently needs the custom property itself.
