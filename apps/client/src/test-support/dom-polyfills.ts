/**
 * jsdom has no `ResizeObserver` at all — cmdk's `Command.List` (#93) uses
 * one to track its own height into a CSS var, which throws on construction
 * under jsdom before any test using the Command Palette gets to render
 * anything. A no-op stand-in is all a layout-less test environment needs:
 * nothing here reads the CSS var cmdk sets from an observed resize.
 */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
}

/** Same gap, same fix: jsdom has no scroll layout either, and cmdk calls this on every selection change to keep the highlighted row in view. */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/**
 * jsdom ships no `Element.scrollTo` at all (#142) — `@tanstack/react-virtual`'s
 * `scrollToOffset`/`scrollToIndex` call it (`elementScroll` in
 * `@tanstack/virtual-core`) to move the real scroll container, which a test
 * asserting a restored offset through `.thread-list.scrollTop` needs to
 * actually happen, not silently no-op the way an absent method would. A
 * real browser also fires a `scroll` event off this call — dispatching one
 * here keeps a listener tracking "the list's current offset" (`VirtualizedThreadList.tsx`)
 * in sync under test the same way it would in one.
 */
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo(
    this: Element,
    ...args: [ScrollToOptions?] | [number, number]
  ) {
    const options = typeof args[0] === "object" ? args[0] : { left: args[0], top: args[1] };
    if (typeof options?.top === "number") this.scrollTop = options.top;
    if (typeof options?.left === "number") this.scrollLeft = options.left;
    this.dispatchEvent(new Event("scroll"));
  } as typeof Element.prototype.scrollTo;
}
