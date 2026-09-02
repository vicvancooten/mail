import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These are integration tests against one real, shared dev Postgres
    // (docs/dev-setup.md) — running test files concurrently would race on
    // the same tables (two files' beforeEach hooks deleting rows out from
    // under each other).
    fileParallelism: false,
    // `pnpm build` compiles src/**/*.test.ts into dist/ too (the build
    // script only carves out db/migrations, not tests) — without this,
    // a stale local `dist/` makes every test run twice.
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
