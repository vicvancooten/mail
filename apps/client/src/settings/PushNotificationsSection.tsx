import { useCallback, useEffect, useState } from "react";
import {
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  fetchVapidPublicKeyIfConfigured,
  hasActivePushSubscription,
  pushSupportState,
} from "../pwa/push.js";

/**
 * "An explicit 'enable on this device' control in settings" (#53,
 * ADR-0015) — one of the two UI surfaces that ever call
 * `Notification.requestPermission()` (the other is the one-time inline
 * offer, `NotificationOfferBanner.tsx`). Renders nothing at all when the
 * operator has never generated a VAPID keypair or this browser has no Push
 * API — there is no partial feature to half-show.
 *
 * A denied device shows the *blocked* explanation ADR-0015 asks for
 * rather than a button that would otherwise look broken: calling
 * `requestPermission()` again after a real denial "resolves instantly and
 * silently", so a plain retry button would look like this app's own bug
 * rather than the browser's permanent decision.
 */
export function PushNotificationsSection() {
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [permission, setPermission] = useState(() => pushSupportState());
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchVapidPublicKeyIfConfigured().then((key) => {
      if (cancelled) return;
      setVapidPublicKey(key);
      setLoaded(true);
    });
    void hasActivePushSubscription().then((active) => {
      if (!cancelled) setSubscribed(active);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEnable = useCallback(async () => {
    if (!vapidPublicKey) return;
    setBusy(true);
    const result = await enablePushOnThisDevice(vapidPublicKey);
    setBusy(false);
    setPermission(pushSupportState());
    if (result.ok) setSubscribed(true);
  }, [vapidPublicKey]);

  const handleDisable = useCallback(async () => {
    setBusy(true);
    await disablePushOnThisDevice();
    setBusy(false);
    setSubscribed(false);
  }, []);

  if (!loaded || vapidPublicKey === null || permission === "unsupported") return null;

  return (
    <section>
      <h3>Push notifications</h3>
      {permission === "denied" ? (
        <p>
          Notifications are blocked for this site. Your browser's site settings are the only way to
          turn them back on.
        </p>
      ) : subscribed ? (
        <button type="button" disabled={busy} onClick={() => void handleDisable()}>
          Disable on this device
        </button>
      ) : (
        <button type="button" disabled={busy} onClick={() => void handleEnable()}>
          Enable on this device
        </button>
      )}
    </section>
  );
}
