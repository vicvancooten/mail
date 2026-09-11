import type { Calendar, ConnectedAccount } from "@mail/shared";
import { useCalendars } from "../store/calendars.js";
import {
  enqueueMutation,
  enqueueUserMutation,
  useConnectedAccounts,
  useMailAccounts,
  usePreference,
} from "../store/index.js";
import { PushNotificationsSection } from "./PushNotificationsSection.js";

/** A Calendar's group heading on this page — "Local" for a Local Calendar, the Connected Account's own identity for a mirrored one (#244's own acceptance line: "Calendars grouped by Origin"). */
function originLabel(calendar: Calendar, connectedAccounts: ConnectedAccount[]): string {
  const origin = calendar.origin;
  if (origin.type === "local") return "Local";
  const account = connectedAccounts.find((entry) => entry.id === origin.connectedAccountId);
  return account?.identity ?? origin.connectedAccountId;
}

/**
 * Settings' Notifications page (#99, widened by #244/ADR-0028): "the one
 * place notification toggles live" — Mail Accounts first (the per-Mail-
 * Account `notificationsEnabled` toggle, moved off `ConnectedAccountsPage.tsx`
 * verbatim, same `setNotificationsEnabled` intent and `enqueueMutation`),
 * then every Calendar grouped by Origin with its own on/off
 * (`setCalendarRemindersEnabled`, User-scoped, synced, defaulting on), then
 * the existing push controls (`PushNotificationsSection`, #53) — "push
 * controls stay hidden when unconfigured" (grill Q21) needed no change here.
 *
 * Each Calendar's toggle also appears on that Calendar's own settings sheet
 * (`CalendarSettingsSheet.tsx`) — the same field, two surfaces, the same
 * "no edit affordance gating" posture Colour already has there, since
 * `remindersEnabled` is Wicket's own and never touches the upstream.
 *
 * "Answer received" (#243) gets its own toggle right beside Reminders,
 * `Preference.answerNotificationsEnabled` — User-scoped rather than
 * per-Calendar, since an Answer names no one Calendar the way a Reminder
 * does (`setAnswerNotificationsEnabled`, `enqueueUserMutation`).
 */
export function NotificationsPage() {
  const mailAccounts = useMailAccounts() ?? [];
  const calendars = useCalendars() ?? [];
  const connectedAccounts = useConnectedAccounts() ?? [];
  const preference = usePreference();

  const groups = new Map<string, Calendar[]>();
  for (const calendar of calendars) {
    const label = originLabel(calendar, connectedAccounts);
    const group = groups.get(label);
    if (group) group.push(calendar);
    else groups.set(label, [calendar]);
  }

  return (
    <section className="settings-page">
      <h2>Notifications</h2>

      {mailAccounts.length > 0 && (
        <section>
          <h3>Mail Accounts</h3>
          {mailAccounts.map((account) => (
            <label key={account.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={account.notificationsEnabled}
                onChange={(event) =>
                  void enqueueMutation(
                    { type: "setNotificationsEnabled", enabled: event.target.checked },
                    account.id,
                  )
                }
              />
              {account.emailAddress}
            </label>
          ))}
        </section>
      )}

      {calendars.length > 0 && (
        <section>
          <h3>Calendars</h3>
          {[...groups.entries()].map(([label, group]) => (
            <div key={label}>
              <h4>{label}</h4>
              {group.map((calendar) => (
                <label key={calendar.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={calendar.remindersEnabled}
                    onChange={(event) =>
                      void enqueueUserMutation({
                        type: "setCalendarRemindersEnabled",
                        calendarId: calendar.id,
                        enabled: event.target.checked,
                      })
                    }
                  />
                  {calendar.name}
                </label>
              ))}
            </div>
          ))}
        </section>
      )}

      {preference && (
        <section>
          <h3>Answers</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={preference.answerNotificationsEnabled}
              onChange={(event) =>
                void enqueueUserMutation({
                  type: "setAnswerNotificationsEnabled",
                  enabled: event.target.checked,
                })
              }
            />
            Notify when an Attendee answers
          </label>
        </section>
      )}

      <PushNotificationsSection />
    </section>
  );
}
