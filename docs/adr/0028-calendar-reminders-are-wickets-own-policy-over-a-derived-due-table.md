# Calendar reminders are Wicket's own notification policy over a derived due table

Wicket rings Calendar Reminders itself, through the existing Notifier and Web Push
([ADR-0015](0015-realtime-is-sse-hints-plus-web-push.md)), for every Calendar the User has not
switched off, including synced ones. **Per-Event Reminders mirror both ways** with the upstream
(Google `reminders.overrides`, CalDAV `VALARM`, Graph `reminderMinutesBeforeStart`), as
[ADR-0025](0025-calendar-mirror-is-upstream-wins-with-a-bounded-outbox.md) already set out. **The
Calendar's Reminder Default does not mirror**: it is a Wicket setting per Calendar, seeded once and
never read from or written to the upstream again, and it holds two lists, one for timed and one for
all-day Events. Which Occurrences are due is held in a **Reminder Due** table the Sync Backend derives
from the mirror, and a snoozed Reminder is a one-off row in that same table that never leaves Wicket.
Decided while resolving [Calendar reminders through the
Notifier](https://github.com/vicvancooten/mail/issues/170) on the [Hub Apps
map](https://github.com/vicvancooten/mail/issues/158).

## Considered options

- **Mirror the default list too**, reading Google's per-user `defaultReminders` on CalendarList and
  pushing edits back: rejected. That list is how *Google* rings; Wicket's is how *Wicket* rings, and
  a User who keeps both apps wants them to differ. Graph has no calendar-level default at all and
  CalDAV has no standard one, so mirroring would have been Google-only behaviour dressed as a model.
  The one exception that stays mirrored is the explicit Reminder on an Event: that is Event content
  the User expects to see in every app, and #168 built its round-trip.
- **Nothing about Reminders touches the upstream**, with per-Event Reminders in a Wicket side table:
  rejected. It hides the Reminder the User set in Google on the Event they are looking at, and makes
  `perEventReminders` (Graph's one slot) meaningless.
- **Fire Local Calendars only**, or default synced Calendars to off, to avoid double-ringing beside
  the vendor's phone app: rejected. Wicket is the primary calendar app on this map; the per-Calendar
  toggle, on by default, is the one switch a User with two apps needs.
- **Compute due-ness at tick time** by joining Occurrences to Reminders, with no derived table:
  rejected. Fired state and snoozed rows would have nowhere to live, and a moved Event could not be
  told apart from one that already rang.
- **Snooze through Graph's native `snoozeReminder`** where available: rejected. Snooze is Wicket
  state; a User-scoped row does the same on every Origin and survives the upstream never having heard
  of it.
- **A ninth copy of the `setTimeout` loop**: rejected. The reminder loop is the first user of a
  shared loop helper, extracted as a Foundations slice; a single process-wide scheduler that sleeps
  until the nearest due time stays in the fog.

## The Reminder Due table

- One row per `(User, Occurrence, minutesBefore)` with `dueAt` and `firedAt`, kept only for
  Occurrences starting within the next five weeks (the longest Reminder is four). Rebuilt by the
  materialiser whenever the Series, its Overrides, the Calendar's Reminder Default, the Calendar's
  toggle or the User's Home Time Zone change; rolled forward daily with the Materialisation Window.
- An all-day Occurrence's start is midnight in the **Home Time Zone**; a floating Occurrence resolves
  there too. The Sync Backend has no viewer zone, and the Calendar's zone is the upstream's choice,
  not the User's.
- A 15-second loop **atomically claims** rows with `dueAt <= now` and `firedAt is null`, the pattern
  pending sends use (`compose/pending-send.ts`) rather than Snooze's blanket `UPDATE`, so two
  processes never ring the same row twice. The first tick runs at boot, which is the whole restart
  story: `dueAt` is absolute, so whatever came due while the process was down is found immediately.
- **Catch-up rule**: a passed `dueAt` still fires if the Occurrence has not started ("starts in N
  min"), fires once as "started N min ago" if it began under 15 minutes ago, and is marked missed
  silently after that. This covers the 5-minute polling cadence ADR-0025 flagged, and an Event moved
  earlier than its own Reminder. An Occurrence that has ended never fires.
- **Skipped**: an Occurrence the User declined, and cancelled Occurrences (already an `exdate`).
  Google's global `remindOnRespondedEventsOnly` is not mirrored.
- Moving an Event after its Reminder fired recomputes `dueAt`, clears `firedAt`, and it fires again
  at the new time. Two Reminders on one Occurrence (10 and 1 minutes) fire separately and share a
  notification tag, so the later replaces the earlier on the device.
- A **snoozed** Reminder is a one-off row (`dueAt = now + N`) flagged so a rebuild neither
  recomputes nor drops it; deleted if the Occurrence is cancelled, left alone if it moves.

## Delivery

- A claimed row records a `calendar_reminder` kind in the existing `notifier_outbox`, dedup key
  `(seriesId, originalStart, minutesBefore, dueAt)`, so the delivery loop, fanout, pruning and badge
  count are unchanged. The per-Calendar toggle gates *recording*, so it silences the OS notification
  and the inline toast alike.
- **One payload kind with `events[]`**, grouped per User by **due minute** at tick time: a single
  entry is tagged by its Occurrence key, a group by its due minute. Mail's `new_mail_burst` is a
  separate kind because a burst drops content; a Reminder group keeps every Event's name, so the
  singular is an array of length one.
- Title is the Event's summary; body is the time range in the Home Time Zone plus location,
  prefixed "in N min" or "now". Tapping opens the Event in an existing window (the Day view with that
  Event open); a group lands on the Day view at the earliest start. A visible Client shows the same
  text as an inline toast, suppressed only when that Event is already open.
- **Snooze** is the one action: a fixed 5 minutes as the OS notification's button (Android and
  desktop; iOS has none, so there it lives on the toast and the Event page), posted to the existing
  notification-actions endpoint with an idempotency key and Background Sync retry exactly as Archive
  is. The toast and the Event page offer 5, 10 and 15 minutes and "at start", the last dropped once
  the Event has begun.

## Settings

- **One on/off per Calendar**, a User-scoped setting synced across devices like the Mail Account
  toggle, on by default for every Origin. Shown on one Notifications settings page listing Mail
  Accounts first, then Calendars grouped by Origin, and again on the Calendar's own settings sheet.
- **Reminder Default** per Calendar: a timed list and an all-day list. The Local "Personal" Calendar
  seeds 10 minutes before for timed Events and the day before at 09:00 (900 minutes) for all-day; a
  synced Calendar seeds its timed list from the upstream's default where it has one, once.
- An Event carries up to five Reminders, capped by the Calendar's `perEventReminders` count (Graph:
  one); `perEventReminders` becomes a number rather than a flag. Presets: at start, 5, 10, 15, 30
  minutes, 1 hour, 1 day, custom up to four weeks; all-day Events get day-based presets instead.

## Consequences

- Fired, missed and snoozed state is server-side only; the Client never syncs it and shows no
  "snoozed until" on the Event.
- Every subscribed device is pushed, as ADR-0015 says; a User with no subscribed device and no open
  Client misses the Reminder, as with mail. The push carries the badge count and never changes it.
- Changing the Home Time Zone recomputes every all-day and floating `dueAt`.
- A **Home Time Zone** now exists as a User-scoped preference, which the fogged "time zones in the
  Calendar UI" work inherits rather than invents.
- **A shared loop helper** (`startLoop`-shaped, one stop-on-SIGTERM registry, identical behaviour)
  replaces the seven hand-rolled `setTimeout` loops as a Foundations slice, so the reminder loop is
  its first new user. A single scheduler that sleeps until the nearest `nextDueAt()` across loops is
  left as fog: it changes *when* queries run and needs its own measurement.
