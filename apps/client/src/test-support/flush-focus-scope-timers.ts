import { afterAll } from "vitest";

/**
 * Radix's `react-focus-scope` (under every Dialog/Popover) schedules a
 * focus-restoration `setTimeout(0)` on each unmount — a real timer, not one
 * `vi.useFakeTimers()` would catch, and one a test's own `cleanup()` can't
 * cancel. If it's still pending when this file's jsdom environment gets torn
 * down for the next test file, it fires against an already-dead `document`
 * and `dispatchEvent` throws `parameter 1 is not of type 'Event'` — an
 * unhandled exception vitest reports against whichever file happens to be
 * running at that moment, not the one that actually left the dialog open.
 * A tick here, once per file after its own tests (and their `afterEach`
 * cleanups) have all run, lets any such timer fire while this file's
 * document is still live.
 */
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
