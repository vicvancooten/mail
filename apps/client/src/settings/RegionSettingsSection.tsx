import type { CalendarView, ClockFormat, FirstDayOfWeek } from "@mail/shared";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CALENDAR_VIEWS } from "../calendar/calendar-url.js";
import { enqueueUserMutation, usePreference } from "../store/index.js";

/**
 * Every IANA zone this browser knows (#189) — `GeneralSection.tsx`'s own
 * Home Time Zone picker, moved here (#303: "Home Time Zone moves into this
 * section").
 */
const TIME_ZONES = Intl.supportedValuesOf("timeZone");

/** A placeholder Select value for the brief window before a seeding effect writes a real value — never a real choice, and disabled so it can never be picked. */
const DETECTING = "__detecting__";

/**
 * A modest curated set of BCP-47 language+region tags (#303) — there is no
 * `Intl.supportedValuesOf("locale")` a browser can enumerate the way
 * `"timeZone"` lets `TIME_ZONES` above build itself from the platform, so
 * this is a hand-picked list rather than a comprehensive one, the same
 * "cheaper hand-written than a client-side dependency" call every other
 * Calendar formatter in this ticket makes. Covers the regions #303's own
 * "outside the US" framing calls out, plus the US itself; a locale this list
 * doesn't carry survives here only as whatever `navigator.language` first
 * seeded (`use-seed-region-locale.ts`) — no picker entry to reselect it from,
 * a real (if narrow) gap future tickets can widen by extending this array.
 */
const REGION_LOCALES = [
  "en-US",
  "en-GB",
  "en-CA",
  "en-AU",
  "en-IE",
  "en-IN",
  "nl-NL",
  "nl-BE",
  "de-DE",
  "de-AT",
  "de-CH",
  "fr-FR",
  "fr-CA",
  "fr-BE",
  "es-ES",
  "es-MX",
  "es-AR",
  "pt-PT",
  "pt-BR",
  "it-IT",
  "sv-SE",
  "da-DK",
  "nb-NO",
  "fi-FI",
  "pl-PL",
  "cs-CZ",
  "ro-RO",
  "hu-HU",
  "el-GR",
  "tr-TR",
  "ru-RU",
  "uk-UA",
  "ar-SA",
  "he-IL",
  "hi-IN",
  "th-TH",
  "vi-VN",
  "id-ID",
  "ja-JP",
  "ko-KR",
  "zh-CN",
  "zh-TW",
  "zh-HK",
] as const;

const LOCALE_DISPLAY = new Intl.DisplayNames(["en"], { type: "language" });

function localeLabel(locale: string): string {
  try {
    return LOCALE_DISPLAY.of(locale) ?? locale;
  } catch {
    // A locale `Intl.DisplayNames` doesn't recognise (never one of the
    // curated tags above, only ever a seeded `navigator.language` value it
    // doesn't carry an entry for) — the raw tag beats throwing mid-render.
    return locale;
  }
}

const VIEW_LABEL: Record<CalendarView, string> = {
  day: "Day",
  workweek: "Work Week",
  week: "Week",
  month: "Month",
  year: "Year",
};

/**
 * Settings' Region Settings page (#303, parent #302/#270): language and
 * region, clock, first day of the week, Calendar's default view, and Home
 * Time Zone (moved here from General) — the one place these all live because
 * every one of them is about how a date or a time *reads*, not what it means
 * ("a person's week does not start on a different day on their phone" is
 * this section's whole reason to sync rather than sit in Device
 * Preferences).
 *
 * Same posture as `GeneralSection.tsx`: every control writes through the
 * Optimistic Action queue (`enqueueUserMutation`) and reads back through
 * `usePreference`'s `base ⊕ pending` overlay.
 */
export function RegionSettingsSection() {
  const preference = usePreference();

  function changeRegionLocale(regionLocale: string) {
    void enqueueUserMutation({ type: "setRegionLocale", regionLocale });
  }

  function changeClockFormat(clockFormat: ClockFormat) {
    void enqueueUserMutation({ type: "setClockFormat", clockFormat });
  }

  function changeFirstDayOfWeek(firstDayOfWeek: FirstDayOfWeek) {
    void enqueueUserMutation({ type: "setFirstDayOfWeek", firstDayOfWeek });
  }

  function changeDefaultCalendarView(defaultCalendarView: CalendarView) {
    void enqueueUserMutation({ type: "setDefaultCalendarView", defaultCalendarView });
  }

  function changeHomeTimeZone(homeTimeZone: string) {
    void enqueueUserMutation({ type: "setHomeTimeZone", homeTimeZone });
  }

  return (
    <section className="settings-page">
      <h2>Region Settings</h2>

      {/* `preference` is `undefined` only for the first frame or two before
          `usePreference()`'s live query resolves (`GeneralSection.tsx`'s own
          doc comment on the same pattern). */}
      {preference && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="region-locale">Language and region</Label>
            <Select
              value={preference.regionLocale === "" ? DETECTING : preference.regionLocale}
              onValueChange={(value) => {
                if (value === DETECTING) return;
                changeRegionLocale(value);
              }}
            >
              <SelectTrigger id="region-locale" className="w-fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {preference.regionLocale === "" && (
                  <SelectItem value={DETECTING} disabled>
                    Detecting…
                  </SelectItem>
                )}
                {REGION_LOCALES.map((locale) => (
                  <SelectItem key={locale} value={locale}>
                    {localeLabel(locale)}
                  </SelectItem>
                ))}
                {/* A seeded locale outside the curated list above still has
                    to be a valid Select value (Radix disallows one with no
                    matching item) — this is that one extra entry, not a
                    second way to pick the same locale twice. */}
                {preference.regionLocale !== "" &&
                  !REGION_LOCALES.includes(
                    preference.regionLocale as (typeof REGION_LOCALES)[number],
                  ) && (
                    <SelectItem value={preference.regionLocale}>
                      {localeLabel(preference.regionLocale)}
                    </SelectItem>
                  )}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="clock-format">Clock</Label>
            <Select
              value={preference.clockFormat}
              onValueChange={(value) => changeClockFormat(value as ClockFormat)}
            >
              <SelectTrigger id="clock-format" className="w-fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatic (from region)</SelectItem>
                <SelectItem value="12">12-hour</SelectItem>
                <SelectItem value="24">24-hour</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="first-day-of-week">First day of the week</Label>
            <Select
              value={preference.firstDayOfWeek}
              onValueChange={(value) => changeFirstDayOfWeek(value as FirstDayOfWeek)}
            >
              <SelectTrigger id="first-day-of-week" className="w-fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="monday">Monday</SelectItem>
                <SelectItem value="sunday">Sunday</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="default-calendar-view">Calendar's default view</Label>
            <Select
              value={preference.defaultCalendarView}
              onValueChange={(value) => changeDefaultCalendarView(value as CalendarView)}
            >
              <SelectTrigger id="default-calendar-view" className="w-fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CALENDAR_VIEWS.map((view) => (
                  <SelectItem key={view} value={view}>
                    {VIEW_LABEL[view]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="home-time-zone">Home Time Zone</Label>
            <Select
              value={preference.homeTimeZone === "" ? DETECTING : preference.homeTimeZone}
              onValueChange={(value) => {
                if (value === DETECTING) return;
                changeHomeTimeZone(value);
              }}
            >
              <SelectTrigger id="home-time-zone" className="w-fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {preference.homeTimeZone === "" && (
                  <SelectItem value={DETECTING} disabled>
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
