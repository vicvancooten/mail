import type { AutoAdvanceDirection, UndoSendDelaySeconds } from "@mail/shared";
import { UNDO_SEND_DELAY_OPTIONS } from "@mail/shared";
import { useCallback } from "react";
import { enqueueUserMutation, usePreference } from "../store/index.js";

/**
 * Every IANA zone this browser knows, for the Home Time Zone picker (#189).
 * `Intl.supportedValuesOf` is the platform's own zone database — no bundled
 * list to keep in sync with tzdata, and never a network round trip.
 */
const TIME_ZONES = Intl.supportedValuesOf("timeZone");

/**
 * Settings' General page (#99): the User-scoped, synced `Preference` fields —
 * Auto-advance on/off + direction, the Undo Send delay, and the Home Time
 * Zone (#189). Split out of the old monolithic `SettingsSection` (#71-era),
 * which stacked this alongside Device Preferences and per-account controls
 * in one long scroll; this page carries only what actually follows the User
 * to another device.
 *
 * Every control writes through the Optimistic Action queue
 * (`enqueueUserMutation`) and reads back through `usePreference`'s `base ⊕
 * pending` overlay, so a change here is visible immediately, offline
 * included, and is what makes it show up on another signed-in device once
 * `POST /sync` carries it there.
 */
export function GeneralSection() {
  const preference = usePreference();

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

  const changeHomeTimeZone = useCallback((homeTimeZone: string) => {
    void enqueueUserMutation({ type: "setHomeTimeZone", homeTimeZone });
  }, []);

  return (
    <section className="settings-page">
      <h2>General</h2>

      {/* `preference` is `undefined` only for the first frame or two before
          `usePreference()`'s live query resolves (`store/reads.ts`'s own
          doc comment). */}
      {preference && (
        <section>
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

          <label>
            Home Time Zone
            <select
              value={preference.homeTimeZone}
              onChange={(event) => changeHomeTimeZone(event.target.value)}
            >
              {/* Seeding (`use-seed-home-time-zone.ts`) races the first paint here on a
                  brand-new device — an empty option keeps the `<select>` valid rather than
                  silently snapping to whatever zone sorts first while it settles. */}
              {preference.homeTimeZone === "" && <option value="">Detecting…</option>}
              {TIME_ZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}
    </section>
  );
}
