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
