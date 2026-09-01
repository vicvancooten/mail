import { useEffect, useState } from "react";
import { subscribeNotificationOfferTrigger } from "../pwa/notification-offer.js";
import {
  enablePushOnThisDevice,
  fetchVapidPublicKeyIfConfigured,
  pushSupportState,
} from "../pwa/push.js";
import { readNotificationOfferShown, writeNotificationOfferShown } from "./device-preferences.js";

/**
 * The second (and last) of ADR-0015's two permission-asking surfaces: "one
 * inline offer after the first successful triage session, tracked by a
 * `notificationOfferShown` Device Preference". `useTriage.ts` is what
 * decides *when* the first success happened
 * (`pwa/notification-offer.ts#notifyTriageSucceeded`); everything here is
 * about whether that moment is still eligible to show anything at all —
 * never on load, and never twice.
 */
export function NotificationOfferBanner() {
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    return subscribeNotificationOfferTrigger(() => {
      // Already shown once (ever, on this device), or the User already has
      // an answer (granted/denied) from some other path — nothing to offer.
      if (readNotificationOfferShown() || pushSupportState() !== "default") return;
      void fetchVapidPublicKeyIfConfigured().then((key) => {
        if (!key) return; // the operator never generated a VAPID keypair — nothing to offer
        setVapidPublicKey(key);
        setVisible(true);
      });
    });
  }, []);

  function dismiss(): void {
    writeNotificationOfferShown();
    setVisible(false);
  }

  async function enable(): Promise<void> {
    if (vapidPublicKey) await enablePushOnThisDevice(vapidPublicKey);
    dismiss();
  }

  if (!visible) return null;

  return (
    <div className="notification-offer-banner" role="status">
      <span>Turn on notifications for new mail on this device?</span>
      <button type="button" onClick={() => void enable()}>
        Enable
      </button>
      <button type="button" onClick={dismiss}>
        Not now
      </button>
    </div>
  );
}
