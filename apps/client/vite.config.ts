/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // #44: manifest + installability + the app-shell-only service worker
    // (ADR-0009-client). `injectManifest` (not `generateSW`) so `src/sw.ts`
    // owns the actual fetch/cache logic by hand — see its docstring for why
    // that's what makes "no API caching, ever" a structural fact rather
    // than a Workbox route someone has to remember to exclude. Disabled in
    // `vite dev`: there's no build to precache, and the dev server already
    // proxies `/auth`/`/sync`/`/healthz` same-origin without a worker.
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        // The app shell itself: the built JS/CSS bundle and the HTML that
        // loads it. Deliberately excludes the manifest and icon PNGs —
        // those matter to *installing* the app, not to running the already-
        // installed one offline, and the OS/browser caches an install's
        // icon on its own once fetched once.
        globPatterns: ["**/*.{js,css,html}"],
      },
      manifest: false, // hand-authored public/manifest.webmanifest, linked from index.html
      injectRegister: false, // main.tsx registers the worker itself, alongside the reload-prompt UX
      devOptions: { enabled: false },
    }),
  ],
  server: {
    // In production Fastify serves the client bundle itself (ADR-0009), so
    // the API is always same-origin. Dev runs the Vite server and
    // `pnpm dev:backend` on separate ports (docs/dev-setup.md); proxying
    // keeps requests same-origin here too, which the session cookie needs.
    proxy: {
      "/auth": "http://127.0.0.1:3000",
      "/sync": "http://127.0.0.1:3000",
      "/healthz": "http://127.0.0.1:3000",
      // #41: GET /threads/:id/messages, /messages/:id/attachments/:part,
      // /messages/:id/image-proxy.
      "/threads": "http://127.0.0.1:3000",
      "/messages": "http://127.0.0.1:3000",
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    // jsdom has no IndexedDB; the Local Cache's suites need one before any
    // module-level Dexie handle is constructed.
    setupFiles: ["./src/test-support/indexeddb.ts", "./src/test-support/virtualization.ts"],
    // Node >=22.4 ships its own global `localStorage`/`sessionStorage`
    // (behind --experimental-webstorage, on by default on recent 22.x).
    // Vitest's jsdom environment only copies a window property onto
    // globalThis when the key is either absent from globalThis or on its
    // fixed allowlist — neither is true for `localStorage`/`sessionStorage`,
    // so Node's own (which throws without --localstorage-file) wins and
    // shadows jsdom's. The `test` script disables Node's copy via
    // NODE_OPTIONS=--no-experimental-webstorage so jsdom's localStorage is
    // the one every suite sees.
  },
});
