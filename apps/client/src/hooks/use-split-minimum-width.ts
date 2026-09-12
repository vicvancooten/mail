import { splitMinimum } from "@mail/design-tokens";
import * as React from "react";

/**
 * The split minimum (#296, `@mail/design-tokens#splitMinimum`, 920px — the
 * list minimum plus a readable Reader): the width below which Mail's Split
 * view falls back to list-then-Reader rather than showing both panes
 * squeezed past readability. Only the *rendered layout* changes — the
 * `"split"` Device Preference itself (`mail/device-preferences.ts#useViewMode`)
 * is untouched, so widening the window past this token restores Split
 * without the User having to re-pick it.
 *
 * Same `matchMedia`-when-available, `window.innerWidth`-fallback shape as
 * `use-phone-width.ts`'s own hook — see its doc comment for why: real
 * reactivity in a browser or a stubbed test
 * (`test-support/match-media.ts`), a one-shot read in jsdom, which ships no
 * `matchMedia` at all.
 */
const SPLIT_MINIMUM = splitMinimum;

function splitMinimumQuery(): MediaQueryList | null {
  return globalThis.matchMedia?.(`(max-width: ${SPLIT_MINIMUM - 1}px)`) ?? null;
}

function currentlyBelowSplitMinimum(): boolean {
  const mql = splitMinimumQuery();
  if (mql) return mql.matches;
  return typeof window !== "undefined" && window.innerWidth < SPLIT_MINIMUM;
}

function subscribeSplitMinimum(listener: () => void): () => void {
  const query = splitMinimumQuery();
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

/** Reactive read for components — `useSyncExternalStore` over the same media query, mirroring `use-phone-width.ts#useIsPhoneWidth`. */
export function useIsBelowSplitMinimum(): boolean {
  return React.useSyncExternalStore(subscribeSplitMinimum, currentlyBelowSplitMinimum, () => false);
}
