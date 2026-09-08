import { HOME_TIME_ZONE_UNSET } from "@mail/shared";
import { useEffect, useRef } from "react";
import { enqueueUserMutation, usePreference } from "../store/index.js";

/**
 * Seeds Home Time Zone (#189) once, the first time this User's own synced
 * `Preference` row reaches a device with no zone on it yet — "at first
 * sign-in, from the signing-in device's own IANA zone" is exactly what this
 * is: a device only ever sees `homeTimeZone === HOME_TIME_ZONE_UNSET` before
 * anyone, on any device, has ever set one.
 *
 * `preference.id === ""` (`reads.ts#defaultPreference`) means the cold-start
 * placeholder, not a real synced row — this waits it out rather than racing
 * it, or a second device would stomp the first device's seed with its own
 * zone before the real row ever arrived. Runs through the ordinary
 * Optimistic Action queue (`enqueueUserMutation`), so an offline first
 * sign-in seeds correctly once the queue drains like any other edit.
 */
export function useSeedHomeTimeZone(): void {
  const preference = usePreference();
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    if (!preference || preference.id === "") return;
    if (preference.homeTimeZone !== HOME_TIME_ZONE_UNSET) return;

    seeded.current = true;
    void enqueueUserMutation({
      type: "setHomeTimeZone",
      homeTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }, [preference]);
}
