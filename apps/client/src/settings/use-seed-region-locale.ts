import { REGION_LOCALE_UNSET } from "@mail/shared";
import { useEffect, useRef } from "react";
import { enqueueUserMutation, usePreference } from "../store/index.js";

/**
 * Seeds Region Settings' language and region (#303) once, the first time
 * this User's own synced `Preference` row reaches a device with no locale on
 * it yet — `use-seed-home-time-zone.ts`'s own shape, just for
 * `navigator.language` instead of the device's IANA zone: "at first sign-in,
 * from the signing-in device's own locale" is exactly what this is.
 *
 * `preference.id === ""` (`reads.ts#defaultPreference`) means the cold-start
 * placeholder, not a real synced row — this waits it out rather than racing
 * it, the same reasoning `useSeedHomeTimeZone` gives.
 */
export function useSeedRegionLocale(): void {
  const preference = usePreference();
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    if (!preference || preference.id === "") return;
    if (preference.regionLocale !== REGION_LOCALE_UNSET) return;

    seeded.current = true;
    void enqueueUserMutation({
      type: "setRegionLocale",
      regionLocale: navigator.language,
    });
  }, [preference]);
}
