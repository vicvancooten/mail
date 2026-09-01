import {
  fetchPushConfig,
  registerPushSubscription,
  unregisterPushSubscription,
} from "../api/push.js";

/**
 * Web Push's subscription lifecycle (#53, ADR-0015): requesting
 * Notification permission, subscribing this device's service worker, and
 * registering the subscription with the Sync Backend. Kept UI-free — the
 * settings control and the one-time inline offer are both thin callers of
 * `enablePushOnThisDevice` — so the flow is unit-testable without a real
 * `Notification`/`PushManager` (jsdom has neither).
 *
 * "Permission asked at most twice" (ADR-0015) is a fact about which *two UI
 * surfaces* ever call this, not bookkeeping this module does itself: a
 * denied `Notification.requestPermission()` resolves instantly and
 * silently on every subsequent call by design (the browser's own behavior),
 * so there is nothing here to guard against a third prompt actually
 * appearing.
 */

export type PushSupport = "unsupported" | NotificationPermission;

/** The slice of `navigator`/`window` this needs — narrowed so a test double beats casting a fake. */
export interface PushHost {
  serviceWorker?: { ready: Promise<{ pushManager: PushManagerLike }> };
}

export interface PushManagerLike {
  subscribe(options: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array;
  }): Promise<PushSubscriptionLike>;
  getSubscription(): Promise<PushSubscriptionLike | null>;
}

export interface PushSubscriptionLike {
  endpoint: string;
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
}

export interface NotificationHost {
  requestPermission(): Promise<NotificationPermission>;
}

/** `"unsupported"` when this browser has no Push API at all — the settings control hides itself in that case. */
export function pushSupportState(
  notificationHost: NotificationHost | undefined = globalThis.Notification,
  pushHost: PushHost | undefined = safeNavigator(),
): PushSupport {
  if (!notificationHost || !pushHost?.serviceWorker || !globalThis.PushManager)
    return "unsupported";
  return globalThis.Notification?.permission ?? "default";
}

export type EnablePushResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "permission_denied" | "no_registration" };

/**
 * Requests permission (if not already decided) and subscribes this device.
 * A prior denial resolves `requestPermission()` immediately with `"denied"`
 * — no second native prompt appears, which is exactly the "effectively
 * permanent" behavior ADR-0015 says the settings control must explain
 * rather than paper over.
 */
export async function enablePushOnThisDevice(
  vapidPublicKey: string,
  {
    notificationHost = globalThis.Notification,
    pushHost = safeNavigator(),
  }: { notificationHost?: NotificationHost; pushHost?: PushHost } = {},
): Promise<EnablePushResult> {
  if (!notificationHost || !pushHost?.serviceWorker) return { ok: false, reason: "unsupported" };

  const permission = await notificationHost.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "permission_denied" };

  const registration = await pushHost.serviceWorker.ready;
  if (!registration) return { ok: false, reason: "no_registration" };

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    return { ok: false, reason: "no_registration" };
  }

  await registerPushSubscription({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  return { ok: true };
}

/** Whether this device already has an active subscription — what the settings control seeds its initial state from on mount. */
export async function hasActivePushSubscription(
  pushHost: PushHost | undefined = safeNavigator(),
): Promise<boolean> {
  const registration = await pushHost?.serviceWorker?.ready;
  const subscription = await registration?.pushManager.getSubscription();
  return subscription !== null && subscription !== undefined;
}

/** The explicit "disable on this device" path — unsubscribes locally and tells the backend to forget it. */
export async function disablePushOnThisDevice(
  pushHost: PushHost | undefined = safeNavigator(),
): Promise<void> {
  const registration = await pushHost?.serviceWorker?.ready;
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await unregisterPushSubscription(endpoint);
}

/** `null` when the operator has never generated a VAPID keypair (`GET /push/config`) — Web Push is then simply not offered. */
export async function fetchVapidPublicKeyIfConfigured(): Promise<string | null> {
  const { vapidPublicKey } = await fetchPushConfig();
  return vapidPublicKey;
}

/** VAPID public keys are URL-safe base64; `PushManager.subscribe` wants raw bytes. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function safeNavigator(): PushHost | undefined {
  return globalThis.navigator as unknown as PushHost | undefined;
}
