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
 *
 * The header's own global search field (#86, the comp's `.global-search`)
 * raises the same request from a place that may already be *on* `/mail`,
 * where nothing is about to mount and consume a flag. So a mounted
 * `MailSection` subscribes, and a request with a live subscriber is
 * delivered straight to it; only a request with nobody listening — the
 * off-`/mail` case `RootLayout` answers by navigating — falls back to the
 * flag.
 */
let pending = false;

const listeners = new Set<() => void>();

export function requestGlobalPaletteOpen(): void {
  if (listeners.size > 0) {
    for (const listener of listeners) listener();
    return;
  }
  pending = true;
}

/** Subscribes a mounted Palette host to requests raised while it is already up. */
export function subscribeGlobalPaletteOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads and clears the flag — call once, from the consumer that acts on it. */
export function consumeGlobalPaletteOpenRequest(): boolean {
  const wasPending = pending;
  pending = false;
  return wasPending;
}
