import * as React from "react";

/**
 * The one desktop/phone breakpoint this app treats as an actual JS
 * mount/unmount split rather than CSS-only visibility — 700px, the same
 * number `router/shell.css`'s `@media (min-width: 701px)` and
 * `mail/Sidebar.tsx`'s own doc comment ("matching the phone rule everywhere
 * else in this app") already use. `hooks/use-mobile.ts`'s `useIsMobile`
 * (768px) is a different, shadcn-only breakpoint and the wrong one to reach
 * for here — `Sidebar.tsx` warns a JS/CSS breakpoint mismatch leaves a dead
 * zone, and Settings (#135) genuinely mounts a different tree per width
 * (list vs full-width page + Back), not just a hidden one.
 */
const PHONE_BREAKPOINT = 700;

function phoneQuery(): MediaQueryList | null {
  return globalThis.matchMedia?.(`(max-width: ${PHONE_BREAKPOINT}px)`) ?? null;
}

/** A plain, synchronous read — usable outside a component, e.g. a route's `beforeLoad`. */
export function isPhoneWidth(): boolean {
  return phoneQuery()?.matches ?? false;
}

function subscribePhoneWidth(listener: () => void): () => void {
  const query = phoneQuery();
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

/** Reactive read for components — `useSyncExternalStore` over the same media query, mirroring `theme/device-theme.ts#useResolvedAppearance`'s system-dark subscription. */
export function useIsPhoneWidth(): boolean {
  return React.useSyncExternalStore(subscribePhoneWidth, isPhoneWidth, () => false);
}
