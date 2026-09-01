// Ambient typing for the one build-time global `vite-plugin-pwa`'s
// `injectManifest` strategy injects into `src/sw.ts`: the precache list of
// this build's hashed app-shell assets. See `sw.ts`'s docstring.
interface ServiceWorkerGlobalScope {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
}
