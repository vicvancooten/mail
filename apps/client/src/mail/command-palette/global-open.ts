/**
 * The bridge that makes `⌘K` reachable from every route (the direction
 * contract's SIGNATURE INTERACTION: "the command palette is the keyboard
 * surface for the whole Client"), even though the Palette itself
 * (`CommandPalette.tsx`, `commands.ts#CommandContext`) is deeply Mail-scoped
 * — it reads the selected Thread, the open message, Screener counts — none
 * of which exists on `/settings` or a placeholder App route.
 *
 * Rather than teaching the Palette a second, degraded command set for
 * routes with nothing to act on yet, `RootLayout` (mounted everywhere)
 * catches `⌘K` outside `/mail`, records the request here, and navigates to
 * `/mail`; `MailSection`'s own mount effect consumes the flag and opens its
 * already-built Palette. A module-level flag rather than a route search
 * param: it is read exactly once, by the next `MailSection` mount, and
 * never belongs in a shareable URL the way `MailSearch`'s fields do.
 */
let pending = false;

export function requestGlobalPaletteOpen(): void {
  pending = true;
}

/** Reads and clears the flag — call once, from the consumer that acts on it. */
export function consumeGlobalPaletteOpenRequest(): boolean {
  const wasPending = pending;
  pending = false;
  return wasPending;
}
