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
