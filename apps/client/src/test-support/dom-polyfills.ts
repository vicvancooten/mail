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
 * jsdom implements the `PointerEvent` constructor but none of the Pointer
 * Capture methods it lets a handler call on the target element — needed by
 * `useSwipeToTriage.ts` (#149), which every row-swipe and Stream-card-swipe
 * integration test drives with real `fireEvent.pointer*` events rather than
 * a hand-built fake event. No-ops are all these tests need: nothing here
 * asserts on capture actually retargeting subsequent moves, only on the
 * offset/commit the hook computes from the events it's handed.
 */
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
