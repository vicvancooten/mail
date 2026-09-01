import type { AutoAdvanceDirection, Theme, UndoSendDelaySeconds } from "@mail/shared";
import { UNDO_SEND_DELAY_OPTIONS } from "@mail/shared";
import { useCallback } from "react";
import { AuthMethodsSection } from "../auth/AuthMethodsSection.js";
import { MailAccountsSection } from "../mail-accounts/MailAccountsSection.js";
import { SignatureEditor } from "../mail-accounts/SignatureEditor.js";
import {
  enqueueMutation,
  enqueueUserMutation,
  useMailAccounts,
  usePreference,
} from "../store/index.js";
import { PushNotificationsSection } from "./PushNotificationsSection.js";

/**
 * The settings screen (#54, poc-spec.md §Preferences): "wiring all of it
 * together" per the ticket — the User-scoped `Preference` controls (theme,
 * Auto-advance, Undo Send delay) and the Mail-Account-scoped ones
 * (signature, notifications) alongside the auth-methods section (#32) and
 * Mail Account management (#33), which already lived here as their own
 * always-visible sections. There is no router in this Client (`AppShell`
 * stacks every section unconditionally), so "a settings screen" means one
 * more such section rather than a navigated-to route — nothing here changes
 * that shape, it just gives Preferences a home instead of the ad hoc inline
 * forms #46/#47's own tickets stood in with.
 *
 * Every control writes through the Optimistic Action queue
 * (`enqueueUserMutation`/`enqueueMutation`) and reads back through the Local
 * Cache's reactive hooks (`usePreference`/`useMailAccounts`) — the exact
 * `base ⊕ pending` overlay every other Preference read gets, so a change
 * here is visible immediately, offline included, and is what makes it show
 * up on another signed-in device once `POST /sync` carries it there.
 */
export function SettingsSection() {
  const preference = usePreference();
  const mailAccounts = useMailAccounts() ?? [];

  const changeTheme = useCallback((theme: Theme) => {
    void enqueueUserMutation({ type: "setTheme", theme });
  }, []);

  const changeAutoAdvanceEnabled = useCallback(
    (enabled: boolean) => {
      if (!preference) return;
      void enqueueUserMutation({
        type: "setAutoAdvance",
        enabled,
        direction: preference.autoAdvanceDirection,
      });
    },
    [preference],
  );

  const changeAutoAdvanceDirection = useCallback(
    (direction: AutoAdvanceDirection) => {
      if (!preference) return;
      void enqueueUserMutation({
        type: "setAutoAdvance",
        enabled: preference.autoAdvanceEnabled,
        direction,
      });
    },
    [preference],
  );

  const changeUndoSendDelay = useCallback((undoSendDelaySeconds: UndoSendDelaySeconds) => {
    void enqueueUserMutation({ type: "setUndoSendDelay", undoSendDelaySeconds });
  }, []);

  return (
    <section className="settings-section">
      <h2>Settings</h2>

      {/* `preference` is `undefined` only for the first frame or two before
          `usePreference()`'s live query resolves (`store/reads.ts`'s own doc
          comment) — everything below this point (auth methods, Mail Account
          management) must keep rendering regardless, so the gate is scoped
          to just this block rather than the whole section. */}
      {preference && (
        <section>
          <h3>Preferences</h3>

          <label>
            Theme
            <select
              value={preference.theme}
              onChange={(event) => changeTheme(event.target.value as Theme)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>

          <label>
            <input
              type="checkbox"
              checked={preference.autoAdvanceEnabled}
              onChange={(event) => changeAutoAdvanceEnabled(event.target.checked)}
            />
            Auto-advance after archive/trash
          </label>

          <label>
            Auto-advance direction
            <select
              value={preference.autoAdvanceDirection}
              disabled={!preference.autoAdvanceEnabled}
              onChange={(event) =>
                changeAutoAdvanceDirection(event.target.value as AutoAdvanceDirection)
              }
            >
              <option value="older">Older</option>
              <option value="newer">Newer</option>
            </select>
          </label>

          <label>
            Undo Send delay
            <select
              value={preference.undoSendDelaySeconds}
              onChange={(event) =>
                changeUndoSendDelay(Number(event.target.value) as UndoSendDelaySeconds)
              }
            >
              {UNDO_SEND_DELAY_OPTIONS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds === 0 ? "off" : `${seconds}s`}
                </option>
              ))}
            </select>
          </label>

          {/* List density is a Device Preference (CONTEXT.md) — deliberately
              not shown here: it lives entirely in `TopBar`'s own toggle, which
              owns its `localStorage` value as this component has no reactive
              subscription to it and duplicating the control risks the two
              drifting out of sync. */}
        </section>
      )}

      {mailAccounts.length > 0 && (
        <section>
          <h3>Mail Account preferences</h3>
          {mailAccounts.map((account) => (
            <div key={account.id} className="account-preferences">
              <strong>{account.emailAddress}</strong>
              <SignatureEditor account={account} />
              <label>
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
                Notifications
              </label>
            </div>
          ))}
        </section>
      )}

      <PushNotificationsSection />
      <AuthMethodsSection />
      <MailAccountsSection />
    </section>
  );
}
