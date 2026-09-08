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
 * jsdom has no hit-testing either — BlockNote's own drag-handle/side-menu
 * extension (`apps/client/src/notes/`, #191) calls this on every
 * `mousemove` over the document to find which block the pointer is over, an
 * uncaught `TypeError` (not a failed assertion) any test rendering a
 * BlockNote editor risks the moment `userEvent` dispatches a synthetic
 * pointer move anywhere on the page (#193's own grid, more than one editor
 * instance mounted at once, first hit this). An empty result is a safe
 * stand-in: nothing under test depends on which element a real hit-test
 * would have found.
 */
if (!document.elementsFromPoint) {
  document.elementsFromPoint = () => [];
}
