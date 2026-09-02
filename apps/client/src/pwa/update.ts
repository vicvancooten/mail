/**
 * The reload-prompt half of #44 (ADR-0009-client: "Client updates prompt,
 * never auto-reload... a new version applies on the next cold start").
 * `registerServiceWorker` installs `src/sw.ts` and watches for a new worker
 * reaching `installed` while an old one is already controlling the page —
 * exactly the "a new bundle exists and this tab is mid-session" case the
 * ADR says must not swap silently. `UpdateBanner` (a sibling file) is the
 * "unobtrusive reload prompt" the ticket asks for; this module is the state
 * machine behind it, kept UI-free so it can be unit tested without a DOM
 * service worker (jsdom has none).
 *
 * The narrow `ServiceWorkerHost` interface below is "the slice of
 * `navigator.serviceWorker` this needs" (the same shape `sync/leader.ts`
 * uses for Web Locks) — a test double satisfies it without faking the whole
 * Service Worker API surface.
 */

export interface ServiceWorkerHost {
  register(scriptUrl: string): Promise<ServiceWorkerRegistrationLike>;
  addEventListener(type: "controllerchange", listener: () => void): void;
  readonly controller: unknown;
}

export interface ServiceWorkerRegistrationLike {
  readonly waiting: ServiceWorkerLike | null;
  addEventListener(type: "updatefound", listener: () => void): void;
  readonly installing: ServiceWorkerLike | null;
}

export interface ServiceWorkerLike {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", listener: () => void): void;
}

let waitingWorker: ServiceWorkerLike | null = null;
const listeners = new Set<() => void>();

/** True once a new worker is installed and waiting to take over — the banner's whole condition. */
export function hasPendingUpdate(): boolean {
  return waitingWorker !== null;
}

export function subscribePendingUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setWaiting(worker: ServiceWorkerLike | null): void {
  if (worker === waitingWorker) return;
  waitingWorker = worker;
  for (const listener of listeners) listener();
}

/**
 * Tells the waiting worker to activate, then reloads once it does
 * (`controllerchange` fires exactly when the new worker takes control —
 * this is the one moment the ADR allows a reload, because the User asked
 * for it). A no-op if nothing is waiting.
 */
export function applyPendingUpdate(
  sw: ServiceWorkerHost = navigatorServiceWorker(),
  reload: () => void = () => globalThis.location?.reload(),
): void {
  if (!waitingWorker) return;
  let reloaded = false;
  sw.addEventListener("controllerchange", () => {
    if (reloaded) return; // a browser can fire this more than once in edge cases; reload exactly once
    reloaded = true;
    reload();
  });
  waitingWorker.postMessage("SKIP_WAITING");
}

function navigatorServiceWorker(): ServiceWorkerHost {
  const sw = (globalThis.navigator as Navigator | undefined)?.serviceWorker;
  if (!sw) throw new Error("no navigator.serviceWorker");
  return sw as unknown as ServiceWorkerHost;
}

/**
 * Registers `/sw.js` and wires the waiting-worker watch above. Silently
 * does nothing where Service Workers don't exist (`vite dev`, an old
 * browser, jsdom under `pnpm test`) — this is cold-start plumbing, not
 * something worth surfacing on a triage surface that is silent when
 * healthy (`sync-loop.ts`'s same rule).
 */
export function registerServiceWorker(
  sw: ServiceWorkerHost | undefined = safeNavigatorServiceWorker(),
): void {
  if (!sw) return;

  void sw
    .register("/sw.js")
    .then((registration) => {
      // A worker already waiting at registration time (this tab loaded
      // after another tab's install finished) is exactly the same "update
      // ready" state as one that arrives while this tab is open.
      if (registration.waiting && sw.controller) setWaiting(registration.waiting);

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          // `sw.controller` set means this is an *update* (a controller
          // already exists from a previous visit), not the very first
          // install — a first install has nothing to prompt about, since
          // there is no "old bundle" the User could be mid-session on.
          if (installing.state === "installed" && sw.controller) setWaiting(installing);
        });
      });
    })
    // `/sw.js` 404s in `vite dev` (no build has produced it) — same
    // "nothing useful to do, say nothing" rule as `use-local-cache-sync.ts`.
    .catch(() => {});
}

function safeNavigatorServiceWorker(): ServiceWorkerHost | undefined {
  try {
    return navigatorServiceWorker();
  } catch {
    return undefined;
  }
}

/** Test seam: the module-level waiting worker outlives one registration, so each test starts clean. */
export function resetPendingUpdate(): void {
  setWaiting(null);
}
