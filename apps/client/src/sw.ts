import type { PushPayload } from "@mail/shared";
import {
  buildArchiveActionRequest,
  buildNotificationContent,
  hasVisibleClient,
  notificationClickTarget,
  parsePushPayload,
} from "./pwa/push-decisions.js";
import { isApiPath, manifestFingerprint } from "./pwa/shell-routing.js";
import { generateUlid } from "./store/ulid.js";

// `lib.webworker.d.ts` (this file's own `tsconfig.sw.json`) types `self` as
// the generic `WorkerGlobalScope` shared across worker kinds; narrow it to
// the service-worker-specific shape (`clients`, `skipWaiting`, …) here.
declare const self: ServiceWorkerGlobalScope;

/**
 * The app-shell-only service worker (#44, `poc-spec.md` §Wire API & client
 * data layer, ADR-0009-client): "the service worker caches the app shell
 * only — no API responses, ever." Offline mail data is the Local Cache's
 * job (IndexedDB via Dexie); an HTTP cache of `/sync`/`/auth` responses
 * would be a second, un-reconcilable source of truth, so this worker never
 * touches `fetch` for anything but the built client bundle and never even
 * registers a route for API paths — there is no cache-vs-network decision
 * to get wrong for them because they're never intercepted at all.
 *
 * Precache list comes from `vite-plugin-pwa`'s `injectManifest` strategy:
 * `self.__WB_MANIFEST` is replaced at build time with every hashed built
 * asset's URL + revision, so a deploy's shell is exactly the files that
 * shipped with it — no separate glob/version list to keep in sync by hand.
 * `injectManifest` (rather than `generateSW`) is deliberate: it hands this
 * file full control instead of Workbox's routing DSL, which is what lets
 * the "no API caching, ever" rule live here as "there is no route for it"
 * rather than "there is a route someone must remember to exclude".
 */

// Populated by vite-plugin-pwa at build time; empty in `vite dev` (no build
// has run), which is fine — dev never installs this worker (see main.tsx).
const PRECACHE_MANIFEST = self.__WB_MANIFEST ?? [];
// A cache name derived from the precache list itself — see
// `manifestFingerprint`'s doc comment for why, which is what lets
// `activate` below drop every previous version's cache without tracking a
// build id by hand.
const SHELL_CACHE = `mail-shell-${manifestFingerprint(PRECACHE_MANIFEST)}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const urls = PRECACHE_MANIFEST.map((entry) => entry.url);
      await cache.addAll(urls);
      // Deliberately no `self.skipWaiting()` here: ADR-0009-client — "Client
      // updates prompt, never auto-reload... a new version applies on the
      // next cold start." A newly installed worker sits in `waiting` until
      // either the reload-prompt banner posts `SKIP_WAITING` (main.tsx) or
      // every tab on the old version closes, which is the browser's own
      // "next cold start" behavior with no extra code needed for it.
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("mail-shell-") && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

const PRECACHED_URLS = new Set(
  PRECACHE_MANIFEST.map((entry) => new URL(entry.url, self.location.origin).pathname),
);

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept mutations — nothing to cache-first here anyway
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // shell only: no cross-origin caching

  // The one hard boundary: API paths are never handled by this listener at
  // all, so the browser's normal networking owns them end to end — no
  // cache read, no cache write, not even a pass-through `fetch()` here.
  if (isApiPath(url.pathname)) return;

  // A precached shell asset: cache-first, since its URL is either
  // content-hashed (the JS/CSS bundle) or, for `index.html`, pinned to this
  // build by `SHELL_CACHE`'s own fingerprint — either way it can never go
  // stale under this specific cache name.
  if (PRECACHED_URLS.has(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
    return;
  }

  // SPA navigation fallback: an offline deep link (e.g. reopening on
  // `/search?q=`) still gets the shell instead of the browser's own
  // offline error page. Online, this always goes to the network first so a
  // navigation never serves a stale shell while online.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(SHELL_CACHE);
        const shell = await cache.match("/index.html");
        return shell ?? Response.error();
      }),
    );
  }
});

/**
 * Web Push & the Notifier (#53, ADR-0015). This is the one place in this
 * file that touches the network for something other than the app shell —
 * deliberately: `POST /notifications/actions` is a direct-apply action, not
 * an API response to cache, so it does not conflict with "no API caching,
 * ever" above (that rule is about *reads through this worker's own fetch
 * handler*, which this code never registers a route in).
 *
 * The overriding constraint on everything below, from `docs/research/0006`
 * §"Other findings": **WebKit revokes the whole push subscription outright**
 * if a service worker fails to call `showNotification` promptly on any
 * push — a bug, a timeout, a malformed payload, anything. Every code path
 * through `handlePush` below ends in a `showNotification` call (or a
 * deliberate, payload-less suppression the ADR itself calls for) before
 * anything else happens; the badge update after it is best-effort and can
 * never delay or throw ahead of that call.
 */

const NOTIFICATION_ACTION_SYNC_TAG = "mail-notification-actions";
const FALLBACK_NOTIFICATION_TAG = "mail-push-fallback";

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event: PushEvent): Promise<void> {
  const payload = safeParsePush(event.data);

  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const visible = hasVisibleClient(clients);

  if (payload && visible) {
    // "A visible window suppresses the OS notification in favour of an
    // inline toast" (ADR-0015) — content-carrying `postMessage` to every
    // visible window; `NewMailToast.tsx` (main thread) is the other half.
    for (const client of clients) {
      if (client.visibilityState === "visible") {
        client.postMessage({ type: "new-mail-toast", payload });
      }
    }
  } else {
    const content = payload
      ? buildNotificationContent(payload)
      : {
          title: "New activity",
          body: "Open Mail to see what's new.",
          tag: FALLBACK_NOTIFICATION_TAG,
        };
    try {
      await self.registration.showNotification(content.title, {
        body: content.body,
        tag: content.tag,
        data: payload,
        actions: content.actions,
      });
    } catch {
      // Nothing more can be done — see this section's own doc comment. A
      // second attempt here would only add latency ahead of the badge call
      // below for a call that already failed once.
    }
  }

  if (!payload) return;
  // Best-effort, strictly after `showNotification`/suppression above, and
  // never allowed to throw ahead of anything (ADR-0015). Unconditional on
  // every kind, including the two that never change the count — "each push
  // is a free self-heal".
  try {
    if (payload.badgeCount > 0) await self.navigator.setAppBadge(payload.badgeCount);
    else await self.navigator.clearAppBadge();
  } catch {
    // Best-effort; see above.
  }
}

function safeParsePush(data: PushMessageData | null): PushPayload | null {
  if (!data) return null;
  try {
    return parsePushPayload(data.json());
  } catch {
    return null;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event));
});

async function handleNotificationClick(event: NotificationEvent): Promise<void> {
  const payload = pushPayloadFromNotificationData(event.notification.data);

  if (event.action === "archive") {
    // Only a single mail notification ever carries this action (a
    // coalesced digest/burst has none — the sender is ambiguous,
    // `push-decisions.ts`), so a stale/mismatched click has nothing to do.
    if (payload?.kind !== "new_mail") return;
    await handleArchiveAction(payload);
    return;
  }

  await focusOrOpenClient(payload);
}

/** "POST direct with a ULID key ... never through the overlay" (ADR-0015) — the Archive button's whole implementation. */
async function handleArchiveAction(
  payload: Extract<PushPayload, { kind: "new_mail" }>,
): Promise<void> {
  const action = buildArchiveActionRequest(payload.mailAccountId, payload.threadId, generateUlid());
  try {
    await postNotificationAction(action);
  } catch {
    await queuePendingAction(action);
    const registration = self.registration;
    if ("sync" in registration) {
      // Chrome/Android: an invisible retry once connectivity returns — no
      // need to re-show anything, `docs/research/0006` §6.
      await registration.sync.register(NOTIFICATION_ACTION_SYNC_TAG).catch(() => undefined);
    } else {
      // No Background Sync here (iOS Safari has none at all, per that same
      // research) — "re-shows the notification on a hard failure" is what
      // carries the retry burden instead, so the User can tap it again.
      const content = buildNotificationContent(payload);
      await self.registration
        .showNotification(content.title, {
          body: content.body,
          tag: content.tag,
          data: payload,
          actions: content.actions,
        })
        .catch(() => undefined);
    }
  }
}

self.addEventListener("sync", (event) => {
  if (event.tag !== NOTIFICATION_ACTION_SYNC_TAG) return;
  event.waitUntil(drainPendingActions());
});

/**
 * "A push-handler bug ... risks silently killing the whole subscription" is
 * about the `push` event above; a dead/rotated subscription is a different,
 * documented event (RFC 8030) this fires for. Best-effort resubscribe with
 * the same VAPID key, then re-register with the backend — a failure here
 * just means the backend prunes this device on its next `404`/`410`, the
 * same as any other dead subscription (ADR-0015: pruning is "eventual, not
 * prompt" on iOS regardless).
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handleSubscriptionChange(event));
});

async function handleSubscriptionChange(event: PushSubscriptionChangeEvent): Promise<void> {
  const applicationServerKey = event.oldSubscription?.options.applicationServerKey;
  if (!applicationServerKey) return;
  try {
    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return;
    await fetch("/push/subscriptions", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      }),
    });
  } catch {
    // Best-effort; see this function's own doc comment.
  }
}

/**
 * "A click always lands where the next decision is" (ADR-0015): every kind
 * focuses (or opens) the one window this Client runs — `new_mail`,
 * `failed_send`, and `needs_reauth` additionally post what to land on (a
 * Thread, a Composition, a Mail Account) via `notification-router.ts` on
 * the main thread. Opening a fresh window (nothing was already open) lands
 * on the app's default route (`/`, which redirects to `/mail`) rather than
 * deep-linking straight into the target's own URL: there is no
 * `postMessage` recipient to hand the target to until that window has
 * loaded and subscribed, and the target names a Thread/Composition/Mail
 * Account id, not a URL — building one here would duplicate
 * `router/routes.tsx`'s own shape in the Service Worker for a path this
 * ticket didn't need. A real gap, left for a follow-up: routes exist now
 * (#71) where they didn't when this was first written.
 */
async function focusOrOpenClient(payload: PushPayload | null): Promise<void> {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = clients[0];
  if (!existing) {
    await self.clients.openWindow("/");
    return;
  }

  await existing.focus();
  if (!payload) return;
  const target = notificationClickTarget(payload);
  if (target.kind === "focus-only") return;
  existing.postMessage({ type: "notification-click", target });
}

function pushPayloadFromNotificationData(data: unknown): PushPayload | null {
  return parsePushPayload(data);
}

/**
 * The pending-actions queue Background Sync retries from — a plain
 * IndexedDB store rather than Dexie: this is the service worker's own tiny,
 * dependency-free queue, deliberately **not** the Client's Optimistic Action
 * overlay (ADR-0015: "never through the overlay" — a service worker has no
 * leader tab, no UI, nothing to roll back visibly).
 */
const PENDING_ACTIONS_DB = "mail-notification-actions";
const PENDING_ACTIONS_STORE = "pending";

interface PendingArchiveAction {
  id: string;
  mailAccountId: string;
  intent: { type: "archive"; threadId: string };
}

function openPendingActionsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PENDING_ACTIONS_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(PENDING_ACTIONS_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queuePendingAction(action: PendingArchiveAction): Promise<void> {
  const db = await openPendingActionsDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PENDING_ACTIONS_STORE, "readwrite");
      tx.objectStore(PENDING_ACTIONS_STORE).put(action);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function drainPendingActions(): Promise<void> {
  const db = await openPendingActionsDb();
  try {
    const actions = await new Promise<PendingArchiveAction[]>((resolve, reject) => {
      const tx = db.transaction(PENDING_ACTIONS_STORE, "readonly");
      const request = tx.objectStore(PENDING_ACTIONS_STORE).getAll();
      request.onsuccess = () => resolve(request.result as PendingArchiveAction[]);
      request.onerror = () => reject(request.error);
    });

    for (const action of actions) {
      try {
        await postNotificationAction(action);
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(PENDING_ACTIONS_STORE, "readwrite");
          tx.objectStore(PENDING_ACTIONS_STORE).delete(action.id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        // Still failing (still offline, most likely) — leave it queued; the
        // next `sync` event (Chrome retries with backoff on its own) tries again.
      }
    }
  } finally {
    db.close();
  }
}

async function postNotificationAction(action: PendingArchiveAction): Promise<void> {
  const response = await fetch("/notifications/actions", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!response.ok) {
    throw new Error(`POST /notifications/actions failed: ${response.status}`);
  }
}
