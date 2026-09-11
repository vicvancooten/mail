import { useCallback } from "react";

/**
 * A ref callback that focuses an element the instant it mounts — the
 * inline-edit affordance `TaskRow.tsx`'s title field and `TasksSidebar.tsx`'s
 * rename/create fields all need (typing has to start immediately, no extra
 * click), without the plain `autoFocus` attribute Biome's `lint/a11y/noAutofocus`
 * flags. A callback ref rather than a `useEffect` over an object ref: the
 * field it attaches to is conditionally rendered (only once the User enters
 * edit mode), mounting fresh well after this component's own first render,
 * and a callback ref fires on every such mount — a `useEffect([])` on the
 * component itself would only ever fire once, before any of these fields
 * exist.
 */
export function useFocusOnMount<T extends HTMLElement>(): (node: T | null) => void {
  return useCallback((node: T | null) => {
    node?.focus();
  }, []);
}
