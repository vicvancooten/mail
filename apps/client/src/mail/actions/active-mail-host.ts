import { useSyncExternalStore } from "react";
import type { ViewOrigin } from "../search/scope.js";
import type { ActionContext } from "./types.js";

/**
 * What the currently mounted Mail-family surface (`MailSection`,
 * `stream/StreamStack`) lets the Hub-level Command Palette reach (#147).
 *
 * The Palette itself moved to `router/RootLayout.tsx` — mounted once, above
 * every App and screen, per #147's own acceptance box — but the Action
 * registry's context (`ActionContext`, #94) and the seeded search scope
 * (`ViewOrigin`, `docs/search-ux-spec.md` §Seeded scope) are both built from
 * state that lives well below the Hub: the selected Thread, the open
 * Message, the current folder. Rather than teaching `RootLayout` a second
 * copy of that state, the mounted surface publishes both here on every
 * render its own `ctx`/`searchOrigin` change, the same module-level channel
 * shape `command-palette/global-open.ts` (now retired) and
 * `actions/surface-handles.ts` already use.
 *
 * `null` when nothing Mail-scoped is mounted (Settings, a placeholder App) —
 * `RootLayout` falls back to `noopActionContext` and `{ kind: "other" }`
 * then, the same "nothing wired" shape the Shortcut Sheet already renders
 * against.
 */
export interface ActiveMailHost {
  ctx: ActionContext;
  searchOrigin: ViewOrigin;
}

let current: ActiveMailHost | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Publishes the mounted surface's live host, clearing it (if it's still its own) on unmount or the next call. */
export function publishActiveMailHost(host: ActiveMailHost): () => void {
  current = host;
  notify();
  return () => {
    if (current === host) {
      current = null;
      notify();
    }
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ActiveMailHost | null {
  return current;
}

/** Reactive read of whichever Mail-family surface is mounted right now. */
export function useActiveMailHost(): ActiveMailHost | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Test-only: drops the published host, so one test's mounted surface never leaks into the next. */
export function resetActiveMailHost(): void {
  current = null;
  listeners.clear();
}
