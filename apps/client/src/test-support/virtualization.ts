/**
 * jsdom's layout engine always reports zero size (no real box model), and
 * `@tanstack/react-virtual` measures `offsetWidth`/`offsetHeight` to size
 * its viewport — real zero forever means the virtualized thread list would
 * never consider any row "in range" and mount nothing under test. Stubbing
 * a fixed, plausible viewport size here is the standard workaround for
 * testing virtualized lists under jsdom.
 */
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    return 600;
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return 400;
  },
});

/**
 * Same gap, one layer down (#142): `@tanstack/virtual-core`'s own
 * `getMaxScrollOffset` reads the real `scrollHeight`/`clientHeight` (not its
 * `estimateSize`-driven `getTotalSize()`) to clamp `scrollToOffset`/
 * `scrollToIndex` — real zero-forever here would clamp every such call to
 * `0` regardless of the offset asked for, silently discarding it. `clientHeight`
 * matches `offsetHeight`'s stubbed viewport; `scrollHeight` reads the
 * virtualizer's own total-size element — `VirtualizedThreadList.tsx`'s
 * immediate child of `.thread-list`, the one place in this Client an inline
 * `height` carries the real (estimated) content size — falling back to the
 * viewport height for any element that isn't one.
 */
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get() {
    return 600;
  },
});
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) {
    const child = this.firstElementChild as HTMLElement | null;
    const childHeight = child ? Number.parseFloat(child.style.height || "0") : 0;
    return Math.max(childHeight, 600);
  },
});
