import type { AutoAdvanceDirection, UndoSendDelaySeconds } from "@mail/shared";
import { UNDO_SEND_DELAY_OPTIONS } from "@mail/shared";
import { useCallback } from "react";
import { enqueueUserMutation, usePreference } from "../store/index.js";

/**
 * Settings' General page (#99): the two User-scoped, synced `Preference`
 * fields — Auto-advance on/off + direction, and the Undo Send delay. Split
 * out of the old monolithic `SettingsSection` (#71-era), which stacked this
 * alongside Device Preferences and per-account controls in one long scroll;
 * this page carries only what actually follows the User to another device.
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
        </section>
      )}
    </section>
  );
}
