import type { AutoAdvanceDirection, UndoSendDelaySeconds } from "@mail/shared";
import { UNDO_SEND_DELAY_OPTIONS } from "@mail/shared";
import { useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { enqueueUserMutation, usePreference } from "../store/index.js";

/**
 * Every IANA zone this browser knows, for the Home Time Zone picker (#189).
 * `Intl.supportedValuesOf` is the platform's own zone database — no bundled
 * list to keep in sync with tzdata, and never a network round trip.
 */
const TIME_ZONES = Intl.supportedValuesOf("timeZone");

/** A placeholder Select value for the brief window before `use-seed-home-time-zone.ts` seeds a real zone — never a real IANA zone name, and disabled so it can never be chosen. */
const DETECTING_TIME_ZONE = "__detecting__";

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
        <section className="flex flex-col gap-4">
          <Label className="flex items-center gap-2">
            <Input
              type="checkbox"
              className="h-4 w-4"
              checked={preference.autoAdvanceEnabled}
              onChange={(event) => changeAutoAdvanceEnabled(event.target.checked)}
            />
            Auto-advance after archive/trash
          </Label>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="auto-advance-direction">Auto-advance direction</Label>
            <Select
              value={preference.autoAdvanceDirection}
              disabled={!preference.autoAdvanceEnabled}
              onValueChange={(value) => changeAutoAdvanceDirection(value as AutoAdvanceDirection)}
            >
              <SelectTrigger id="auto-advance-direction" className="w-fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="older">Older</SelectItem>
                <SelectItem value="newer">Newer</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="undo-send-delay">Undo Send delay</Label>
            <Select
              value={String(preference.undoSendDelaySeconds)}
              onValueChange={(value) => changeUndoSendDelay(Number(value) as UndoSendDelaySeconds)}
            >
              <SelectTrigger id="undo-send-delay" className="w-fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNDO_SEND_DELAY_OPTIONS.map((seconds) => (
                  <SelectItem key={seconds} value={String(seconds)}>
                    {seconds === 0 ? "off" : `${seconds}s`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="home-time-zone">Home Time Zone</Label>
            <Select
              value={preference.homeTimeZone === "" ? DETECTING_TIME_ZONE : preference.homeTimeZone}
              onValueChange={(value) => {
                if (value === DETECTING_TIME_ZONE) return;
                changeHomeTimeZone(value);
              }}
            >
              <SelectTrigger id="home-time-zone" className="w-fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Seeding (`use-seed-home-time-zone.ts`) races the first paint here on a
                    brand-new device — a disabled placeholder item keeps the Select's own
                    value valid (Radix disallows an empty string) rather than silently
                    snapping to whatever zone sorts first while it settles. */}
                {preference.homeTimeZone === "" && (
                  <SelectItem value={DETECTING_TIME_ZONE} disabled>
                    Detecting…
                  </SelectItem>
                )}
                {TIME_ZONES.map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </section>
      )}
    </section>
  );
}
