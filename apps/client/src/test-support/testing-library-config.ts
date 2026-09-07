import { configure } from "@testing-library/react";

/**
 * Testing Library's own `findBy*`/`waitFor` polling gives up after 1000ms
 * by default — a budget independent of (and much tighter than) Vitest's
 * `testTimeout` (`vite.config.ts`). A busy CI runner can stretch a routine
 * debounce-then-fetch-then-render past that 1000ms window by chance even
 * though the whole test still finishes comfortably inside its own timeout,
 * which is exactly what was still flaking `search-integration.test.tsx`'s
 * `openResultsView` (its `findByRole("option", { name: /See all results/ })`
 * waits out `useSearchState.ts`'s real 200ms debounce) after `maxWorkers`
 * was capped. Raised to match the headroom `testTimeout` already gives the
 * test as a whole.
 */
configure({ asyncUtilTimeout: 5000 });
