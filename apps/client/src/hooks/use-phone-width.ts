import { phoneBreakpoint } from "@mail/design-tokens";
import * as React from "react";

/**
 * The Client's one phone breakpoint (#273, `@mail/design-tokens#phoneBreakpoint`,
 * 768px — #270's own unchanged phone-chrome value). Before this ticket the
 * app carried two: this hook's own 700px JS/CSS mount split (deciding the
 * Mail list/Reader split-vs-stacked shape and the Settings rail-vs-full-width
 * shape) and a second, shadcn-derived 768px hook (`hooks/use-mobile.ts`,
 * since deleted) that only the Hub's phone chrome read. A window between the
 * two left phone chrome wrapped around a still-desktop layout — every
 * consumer now reads this one hook and this one number instead.
 *
 * Reads `matchMedia` when it's available (real browsers, and any test that
 * stubs it in via `test-support/match-media.ts`) so a resize/stub `"change"`
 * event is real reactivity; falls back to a one-shot `window.innerWidth`
 * comparison when it isn't (jsdom ships no `matchMedia` at all) — the same
 * "best-effort, falls back to a default" posture `theme/device-theme.ts`'s
 * own media query read already takes, and what let every existing
 * `window.innerWidth`-driven integration test (`app-shell-integration.test.tsx`)
 * keep working unchanged once `hooks/use-mobile.ts`'s callers moved here.
 */
const PHONE_BREAKPOINT = phoneBreakpoint;

function phoneQuery(): MediaQueryList | null {
  return globalThis.matchMedia?.(`(max-width: ${PHONE_BREAKPOINT - 1}px)`) ?? null;
}

function currentPhoneWidth(): boolean {
  const mql = phoneQuery();
  if (mql) return mql.matches;
  return typeof window !== "undefined" && window.innerWidth < PHONE_BREAKPOINT;
}

/** A plain, synchronous read — usable outside a component, e.g. a route's `beforeLoad`. */
export function isPhoneWidth(): boolean {
  return currentPhoneWidth();
}

function subscribePhoneWidth(listener: () => void): () => void {
  const query = phoneQuery();
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

/** Reactive read for components — `useSyncExternalStore` over the same media query, mirroring `theme/device-theme.ts#useResolvedAppearance`'s system-dark subscription. */
export function useIsPhoneWidth(): boolean {
  return React.useSyncExternalStore(subscribePhoneWidth, currentPhoneWidth, () => false);
}
