/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // In production Fastify serves the client bundle itself (ADR-0009), so
    // the API is always same-origin. Dev runs the Vite server and
    // `pnpm dev:backend` on separate ports (docs/dev-setup.md); proxying
    // keeps requests same-origin here too, which the session cookie needs.
    proxy: {
      "/auth": "http://127.0.0.1:3000",
      "/sync": "http://127.0.0.1:3000",
      "/healthz": "http://127.0.0.1:3000",
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    // jsdom has no IndexedDB; the Local Cache's suites need one before any
    // module-level Dexie handle is constructed.
    setupFiles: ["./src/test-support/indexeddb.ts", "./src/test-support/virtualization.ts"],
  },
});
