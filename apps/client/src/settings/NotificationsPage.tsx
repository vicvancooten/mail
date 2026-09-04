import { PushNotificationsSection } from "./PushNotificationsSection.js";

/**
 * Settings' Notifications page (#99): just `PushNotificationsSection`
 * (#53), which already renders nothing at all when the operator has never
 * configured VAPID or this browser has no Push API — "push controls stay
 * hidden when unconfigured" (grill Q21) needed no change here, only a page
 * of its own to live on.
 */
export function NotificationsPage() {
  return (
    <section className="settings-page">
      <h2>Notifications</h2>
      <PushNotificationsSection />
    </section>
  );
}
