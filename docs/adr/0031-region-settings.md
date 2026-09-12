# Region Settings is a synced Preference, formatted with Intl alone

Every date or time a User reads — a Calendar Occurrence, a Mail Thread's timestamp — has to pick a
language, a 12/24 clock, a first day of the week, and (for Calendar) a default view. **Region
Settings** (#303, parent #302/#270) is that choice, held as four new fields on the existing synced
`Preference` row (`sync.ts`) rather than four local-only client settings: `regionLocale`,
`clockFormat`, `firstDayOfWeek`, `defaultCalendarView`. A signed-in User gets the same rendering on
every device, the same posture Home Time Zone already set for time zone (`sync.ts`'s own doc
comment) — a User picking Dutch date order on a laptop and seeing US order on a phone would read as
a bug, not a feature.

## Considered options

- **Local-only, per-device (`localStorage`)**: rejected. It's cheaper, but a synced User is one
  identity across devices in every other App (ADR-0010's store-as-truth model); leaving this the one
  setting that doesn't follow would surprise every User who owns more than one device.
- **A date library (`date-fns`, `luxon`, `dayjs`) for locale-aware formatting**: rejected, the same
  call `calendar-dates.ts` already made for civil-date arithmetic. `Intl.DateTimeFormat` already
  knows every locale's date order, clock convention and week numbering; a library would duplicate
  that table client-side for no gain other than a friendlier API.
- **A fifth Preference group of its own collection**: rejected. Four fields is Home Time Zone's own
  size, and `Preference` already holds unrelated single-User settings; a new collection would need
  its own sync plumbing for no reason four more columns don't already serve.

## The field set and defaults

- `regionLocale`: a BCP-47 tag (e.g. `"en-US"`), or `REGION_LOCALE_UNSET` (`""`) until seeded.
  Seeding from `navigator.language` happens once, client-side, at sign-in
  (`use-seed-region-locale.ts`) — never guessed server-side. Every formatter treats `""` as "let
  `Intl` pick the viewer's own default" by passing `undefined`, not `""`, to its constructors.
- `clockFormat`: `"auto" | "12" | "24"`, default `"auto"` — `"auto"` defers to whatever the resolved
  locale's own convention is; `"12"`/`"24"` force one regardless of locale.
- `firstDayOfWeek`: `"monday" | "sunday"`, default `"monday"` (ISO-8601) — the same default
  `calendar-dates.ts` hard-coded before this ticket, now a per-User choice instead.
- `defaultCalendarView`: one of Calendar's five views (`calendar-url.ts#CALENDAR_VIEWS`), default
  `"week"` — declared in `region-settings.ts` rather than only client-side, since the Sync Backend's
  schema needs the same enum; `calendar-url.ts` re-exports it so there is exactly one list of views.

Each field gets its own absolute-set mutation intent (`setRegionLocale`, `setClockFormat`,
`setFirstDayOfWeek`, `setDefaultCalendarView`) rather than one combined "set region settings"
intent — the same one-field-per-intent posture every other single-value Preference already uses, so
a User changing only the clock format doesn't race a stale read of the other three.

## Consequences

- `region-settings.ts` owns the schemas, defaults, and one shared formatting helper
  (`formatRegionDate`, `formatRegionTime`, `formatHourLabel`, `civilInstantInZone`) that every
  date/time in Calendar routes through — no component hand-rolls its own `Intl.DateTimeFormat` call.
  Mail's own dates (#304) route through the same helper rather than a second one, so a locale or
  clock change is felt identically in both Apps.
- Calendar's grids (`DayTimeGrid.tsx`'s hour rail, the Week/Work Week/Month/Year grids' own start-of-
  week arithmetic) and Mail's Time Group ladder (`time-groups.ts`) both key off `firstDayOfWeek` and
  `clockFormat` through this one module, rather than each App discovering its own default.
- `calendar-url.ts#resolveCalendarView` falls back to `defaultCalendarView` once no `?view=` is on
  the URL — the default view is a fallback, never a redirect away from a URL the User actually
  navigated to.
- Seeding is one-way and one-time: once `regionLocale` is no longer `REGION_LOCALE_UNSET`, nothing
  server-side ever overwrites it again, matching Home Time Zone's own "seed once, then it's the
  User's" rule.
