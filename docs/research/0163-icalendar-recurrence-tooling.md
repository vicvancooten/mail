# iCalendar and recurrence tooling for TypeScript

Research for [issue #163 "Research: iCalendar and recurrence tooling for TypeScript"](https://github.com/vicvancooten/mail/issues/163)
(child of [#158, the Hub Apps wayfinder map](https://github.com/vicvancooten/mail/issues/158)).

Question: which TypeScript tooling should the Calendar model build on for iCalendar
parsing/generation and recurrence expansion, and what are the traps? Surveyed: `ical.js`,
`node-ical`, `rrule` (rrule.js), `rschedule`, `ical-generator`, `@date-fns/tz`, and the Temporal
proposal, against RFC 5545 (RRULE/EXDATE/RDATE, VTIMEZONE, DATE-TIME forms), RFC 5546 (iTIP, for
invite email), and RFC 7529 (RSCALE). Cross-cut against DST/timezone handling, floating times,
all-day events, performance expanding a 15-year recurring series into a single week view, bundle
size in the Client, and maintenance status — grounded in each library's own source, README,
CHANGELOG, issue tracker, and npm/bundlephobia data, not secondary summaries.

This sits against [#158's charted ceiling](https://github.com/vicvancooten/mail/issues/158) for
v1 Calendar — "day/week/month, multiple calendars, recurrence, invites both ways, reminders" — and
its "Mirror with upstream-wins" decision: the Sync Backend holds a full mirror of each synced
calendar, edits apply optimistically and push upstream, and on conflict upstream wins
(reusing [ADR-0010](../adr/0010-store-as-truth-with-a-pending-mutation-overlay.md) and
[ADR-0019](../adr/0019-undo-is-an-inverse-action-not-a-queue-cancellation.md)). "Time zones in the
Calendar UI" and Microsoft Graph specifics are both flagged there as not yet specified — this
document's findings feed directly into both.

---

## 1. RFC 5545 ground truth

[RFC 5545](https://www.rfc-editor.org/rfc/rfc5545) is what "correct" means here; every library
below is graded against it, not against what feels intuitive.

### 1.1 The three DATE-TIME forms (§3.3.5) — floating time is the trap

RFC 5545 §3.3.5 defines exactly three forms a DATE-TIME value can take, and the floating-time
clause is the one worth quoting exactly because it is the source of most real-world bugs:

- **Form #1, local/floating**: no `Z` suffix, no `TZID` parameter. The RFC's own words: *"DATE-TIME
  values of this type are said to be 'floating' and are not bound to any time zone in particular.
  ... The use of local time in a DATE-TIME value without the 'TZID' property parameter is to be
  interpreted as floating time, regardless of the existence of 'VTIMEZONE' calendar components."*
  That last clause is load-bearing: a bare `DTSTART:19980101T090000` stays floating even if the
  same `.ics` happens to carry a `VTIMEZONE` block elsewhere — nothing implicitly attaches. This is
  exactly the "9am wherever you are" case: a floating DTSTART is meant to render as 9am in whatever
  zone the *viewer* is currently in, not to be converted through any fixed offset.
- **Form #2, UTC**: identified by a trailing `Z` (`19980119T070000Z`).
- **Form #3, zoned**: a `TZID` parameter pointing at a `VTIMEZONE` component in the same object
  (`DTSTART;TZID=America/New_York:19980119T020000`).

### 1.2 VTIMEZONE (§3.6.5) — embedded rules, not a reference to a system database

A `VTIMEZONE` component carries one or more `STANDARD`/`DAYLIGHT` sub-components, each with
`TZOFFSETFROM`/`TZOFFSETTO` and, for recurring transitions, its own `RRULE` (e.g. "second Sunday in
March"). The RFC requires *"An individual VTIMEZONE calendar component MUST be specified for each
unique TZID parameter value specified in the iCalendar object"* — a `TZID` elsewhere resolves
against the `VTIMEZONE` whose own `TZID` property matches, not against an IANA tzdata lookup. This
is the crux of the interop trap in §4 below: `VTIMEZONE` is a **self-contained, exportable rule
set**, and a producer is free to write "America/New_York" as the `TZID` string while embedding
transition rules that drift from the real IANA `America/New_York` rules (stale historical dumps,
truncated future rules, or an outright custom zone).

### 1.3 DATE value type and all-day events (§3.3.4)

`DATE` values are bare `YYYYMMDD`, no time component. `VALUE=DATE` on `DTSTART`/`DTEND` is how
all-day events are represented — a date-only range, not a zoned instant with a time defaulted to
midnight. Treating an all-day event as "midnight in some timezone" rather than as a bare calendar
date is the most common implementation bug (§5).

### 1.4 RRULE grammar and evaluation order (§3.8.5.3)

Rule parts: `FREQ` (mandatory: SECONDLY/MINUTELY/HOURLY/DAILY/WEEKLY/MONTHLY/YEARLY),
`INTERVAL` (default 1), `BYSECOND`/`BYMINUTE`/`BYHOUR`, `BYDAY` (weekday, optionally with an
ordinal like `2MO`), `BYMONTHDAY`, `BYYEARDAY`, `BYWEEKNO`, `BYMONTH`, `BYSETPOS`, `WKST`, and
`UNTIL`/`COUNT` (mutually exclusive). The RFC states the evaluation order explicitly — this exact
sentence is the correctness bar for any hand-rolled expander: *"If multiple BYxxx rule parts are
specified, then after evaluating the specified FREQ and INTERVAL rule parts, the BYxxx rule parts
are applied to the current set of evaluated occurrences in the following order: BYMONTH,
BYWEEKNO, BYYEARDAY, BYMONTHDAY, BYDAY, BYHOUR, BYMINUTE, BYSECOND and BYSETPOS"* — with
`COUNT`/`UNTIL` evaluated after that. `BYSETPOS` is defined as selecting *"the nth occurrence
within the set of recurrence instances specified by the rule"* — i.e. applied last, as a filter
over the already-fully-expanded candidate set for that period, which is exactly why it is the rule
part every partial implementation below (§3) drops first: it requires the full BY-filter pipeline
to exist before it can mean anything.

`EXDATE` (§3.8.5.1) removes specific instances from the recurrence set generated by RRULE/RDATE.
`RDATE` (§3.8.5.2) adds one-off DATE/DATE-TIME/PERIOD instances beyond what RRULE generates. Both
are set operations against the *materialized* occurrence set, not modifications to the rule
itself.

### 1.5 RFC 5546 (iTIP) — relevant, because #158 commits to invites both ways

[RFC 5546](https://www.rfc-editor.org/rfc/rfc5546) matters directly here: #158 commits to "invites
both ways" and to local calendars sending their own iMIP invites through a Mail Account, so the
Calendar model will parse and generate `METHOD:REQUEST`/`REPLY`/`CANCEL` messages, not just
freestanding `.ics` files. The structural requirements: `REQUEST` (§3.2.2) needs `UID`, `DTSTAMP`,
`DTSTART`, `ORGANIZER`, `SUMMARY`, ≥1 `ATTENDEE`, and `SEQUENCE` once revised past 0; `RECURRENCE-ID`
marks a single-instance edit to a recurring series. `REPLY` (§3.2.3) must echo the same `UID`/
`SEQUENCE` and carry exactly the replying `ATTENDEE`. `CANCEL` (§3.2.5) needs `SEQUENCE`, and
either omits `RECURRENCE-ID` (cancels the whole series) or sets it, optionally with
`RANGE=THISANDFUTURE` (cancels one instance or a tail of the series). **`UID` + `SEQUENCE` +
`RECURRENCE-ID` is the identity/versioning triad** the Calendar model needs regardless of which
library parses the surrounding MIME — none of the libraries below implement iTIP semantics for
you; they parse/emit the VEVENT properties iTIP is built from, and the request/reply/cancel state
machine is application logic on top.

### 1.6 RFC 7529 (RSCALE) — not relevant here

[RFC 7529](https://www.rfc-editor.org/rfc/rfc7529) adds an `RSCALE` parameter to RRULE for
non-Gregorian calendar systems (Hebrew, Islamic-civil, Chinese, Ethiopic, via the CLDR calendar
registry) plus a `SKIP` parameter for invalid-date handling. None of Google Calendar, CalDAV
servers, or Microsoft Graph — the three backends #158 specs, in that order — commonly emit RSCALE.
Skip it unless a non-Gregorian-calendar requirement becomes explicit; no library surveyed below
implements it.

---

## 2. Parsing/generation libraries: `ical.js`, `node-ical`, `ical-generator`

### 2.1 `ical.js` — parser and generator, isomorphic, own recurrence engine with real gaps

[`ical.js`](https://github.com/kewisch/ical.js) (canonical repo has moved to `kewisch/ical.js`;
`mozilla-comm/ical.js` redirects there, and `package.json`'s `repository` field on npm confirms
the new location) is both a parser **and** a generator — `lib/ical/stringify.js` round-trips its
`jCal` intermediate representation back to iCalendar text — and ships its own recurrence engine:
`ICAL.RecurIterator` (`next(again=false): Time|null`) and `ICAL.RecurExpansion`
(`next(): Time`, plus `toJSON()`/resume for continuing expansion later). `ICAL.Event` is
hardcoded to VEVENT specifically. It has **zero runtime dependencies** and is genuinely isomorphic
— it runs in a browser as readily as in Node.

**RFC coverage**: VTODO/VJOURNAL parse at the design layer (no dedicated VFREEBUSY component
design, only a bare property); all RRULE parts are present in `lib/ical/recur.js`, including
BYSETPOS, BYWEEKNO, and BYYEARDAY; EXDATE/RDATE are both read by `RecurExpansion`. But the source's
own comments admit real gaps: **BYWEEKNO is unimplemented for a standalone yearly rule**, and
monthly `BYDAY`+`BYMONTHDAY` combinations are capped at a **48-month internal search window** —
both are incompleteness admitted in-source, not inferred. Open issues corroborate live bugs on top
of that: [`#960`](https://github.com/kewisch/ical.js/issues/960) BYSETPOS ignored for certain
MONTHLY rules (a fix PR, `#985`, is pending, unmerged); `#578` BYSETPOS+YEARLY needs porting from
libical; `#148` there is **no built-in windowed "between" method** — expanding into a bounded
window means manually looping `next()` yourself; `#456` the iterator can emit an occurrence before
the event's own start; `#294` DTSTART itself is sometimes excluded from the expansion; `#353` no
`isAllDay()` convenience helper exists on `ICAL.Event`.

**Timezone handling**: a `ICAL.TimezoneService` singleton registry holds known zones, but **ships
no built-in IANA zoneinfo data of its own** — a bare `TZID` with no embedded `VTIMEZONE` in the
same file won't resolve unless something else registers that zone first. Open issues: `#847`
VTIMEZONE's own DTSTART interpreted as UTC when it shouldn't be; `#795` zone/timezone field
confusion; `#582` an unregistered TZID fails silently with no warning; `#318`/`#295`/`#257` assorted
timezone-adjustment bugs. No Google-vs-Outlook-specific issue turned up for ical.js specifically —
that gap is filled by concrete evidence from node-ical instead (§2.2, §4).

**Floating time**: `ICAL.Time.zone` defaults to a `Timezone.localTimezone` singleton when no
TZID/`Z` is present — i.e. it resolves floating time against whatever zone the *process running
ical.js* is in, not null/unset. `#795` (open) and a historical closed `#403` both track confusion
in this area.

**All-day (VALUE=DATE)**: a boolean `isDate` flag on `ICAL.Time`, with an `icaltype` getter
returning `'date'` vs `'date-time'` — no dedicated `isAllDay()` API exists (open request `#353`).

**Performance / bounded expansion**: genuinely supports windowed iteration in principle —
`RecurExpansion.next()` returns one occurrence per call (capped at ~500 internal attempts per
call) specifically so a caller can bound scope and resume later via `toJSON()` — but there is no
convenience "between" call (`#148`, open), so hitting a specific window means writing that loop
yourself rather than calling one method.

**Maintenance**: latest npm version **2.2.1** (2025-08-08); history 2.0.0 (2024-03-29) → 2.0.1 →
2.1.0 (2024-09-12) → 2.2.0 (2025-06-28) → 2.2.1, with commits as recent as **2026-09-04** — actively,
if modestly, maintained (Philipp Kewisch). 53 open issues, 21 open PRs. The in-repo
`CHANGELOG.md` is stale (stops at v1.3.0/2018); real version history has to come from the npm
registry/git tags instead, not the changelog file.

**Bundle size**: bundlephobia reports **22,807 B gzip** / 77,640 B minified, 0 runtime
dependencies. (npm's reported "unpacked size" of ~1.2MB is the full published package including
multiple dist builds and type definitions, not what a bundler actually ships.)

### 2.2 `node-ical` — parser only, Node-only, mid-rewrite with a live unpatched DoS issue

[`node-ical`](https://github.com/jens-maus/node-ical) (npm `node-ical`) is **parser-only** — no
generation/serialization API exists in its README or source. It just underwent a major rewrite:
version 0.27.0 (2026-07-19) migrated the package to ESM and **swapped its recurrence engine from
`rrule` to `rrule-temporal`** (a third-party library built on the TC39 Temporal polyfill). This was
independently confirmed directly against `package.json` on the published package: `"type":
"module"`, `"engines": {"node": ">=22"}`, and dependencies are exactly `rrule-temporal` and
`temporal-polyfill` — **no `rrule` dependency at all**. Any older description of node-ical as "an
`rrule` wrapper" is stale as of mid-2026.

**RFC coverage**: VEVENT/VTODO/VJOURNAL are confirmed in its parsing dispatch table; VALARM parses
as a sub-component. RRULE BY-parts delegate entirely to `rrule-temporal`, which documents support
for the full set. EXDATE is fully implemented (dual date/timestamp keying). **RDATE is not found
anywhere in node-ical's own parsing dispatch table** — a real, apparently untracked gap against RFC
5545 §3.8.5.2. `VALUE=DATE` vs `DATE-TIME` is distinguished via an `isDateOnly()` check plus a
`.dateOnly = true` marker.

Open issues are concrete and current: **[`#542`](https://github.com/jens-maus/node-ical/issues/542)**
(open, filed 2026-08-19, security/DoS-rated) — `expandRecurringEvent()` can **OOM a Node process on
a sub-1KB YEARLY RRULE** with dense BY-lists plus `COUNT=1`, because the underlying engine builds
the full BY-part cross-product (up to ~31.5M candidates) *before* applying COUNT/window filtering —
no fix merged as of this research. **[`#544`](https://github.com/jens-maus/node-ical/issues/544)**
(open, 2026-08-30) — Outlook all-day recurring events in positive-UTC-offset zones (BST/CEST/IST)
expand to **zero occurrences and silently vanish** (a fix candidate, `#543`, is pending, unmerged).
`#531` (closed, not planned) — `FREQ=YEARLY;BYMONTHDAY=7` with no `BYMONTH` incorrectly recurs
monthly. `#499` (closed) — a regression from the rrule→rrule-temporal migration itself
(`.before is not a function`), fixed in 0.26.1 — evidence the rewrite has already shipped at
least one real regression.

**Timezone handling** — this is where node-ical has real, concrete Google-vs-Outlook evidence,
unlike ical.js: `VTIMEZONE` is resolved to an IANA zone by probing UTC-offset behavior at
reference dates in January and July (`lib/tz-utils.js`); a bare `TZID` checks a bundled
`windowsZones.json` mapping first, then falls back to `Intl.supportedValuesOf('timeZone')`. It
ships **no timezone database of its own** — it relies entirely on the host engine's IANA data via
the Temporal polyfill/`Intl`. Concrete divergence found in the tracker:
**[`#478`](https://github.com/jens-maus/node-ical/issues/478)** (closed) — Outlook/Exchange's
non-standard `Customized Time Zone` / `tzone://Microsoft/Custom` TZIDs were silently falling back
to host-local time instead of reading the embedded VTIMEZONE, now special-cased;
**[`#459`](https://github.com/jens-maus/node-ical/issues/459)** (closed) — a moved occurrence in a
whole-day recurring event worked correctly against a **Gmail** export but broke against an
**Exchange/O365** export — a direct, confirmed instance of the exact Google-vs-Outlook divergence
this research asked about; `#495` (closed) — a VTIMEZONE with `DTSTART` year 0001 crashed
Temporal's `Instant.from()`, now guarded against.

**Floating time**: an explicit source comment states floating DATE-TIME (no TZID, no `Z`) should
"stay in local wall-clock time with no timezone conversion" per RFC 5545, matching §1.1. In
practice it either (a) borrows a lone `VTIMEZONE` elsewhere in the same `VCALENDAR` if exactly one
exists (added for a real-world WordPress-export case, issue `#305`/PR `#307`), or (b) falls back to
`new Date(year, month, day, h, m, s)` — **interpreted in whatever timezone the Node process itself
is running in**. For a Sync Backend that might run in a container set to UTC while events were
authored in the household's local zone, this is a live practical risk, not a theoretical one.

**All-day (VALUE=DATE)**: modeled as a plain JS `Date` built from *local* (not UTC) components — a
source comment states the assumption directly: "assume same timezone as this computer" — plus the
`.dateOnly` marker. The maintainers are demonstrably aware of the classic day-shift failure mode:
an explicit code comment in the EXDATE-matching path walks through exactly the
"2024-07-15 midnight in UTC+2 → 2024-07-14T22:00Z" bug and patches around it for that one code
path — but `#459` and `#544` above show related all-day/recurring breakage is still surfacing
elsewhere in the codebase.

**Performance / bounded expansion**: `expandRecurringEvent(event, {from, to, ...})` is an explicitly
bounded, windowed API — not eager full materialization. `rrule-temporal` itself exposes
`.all()`/`.between()`/`.next()`/`.previous()` with documented safety caps (`maxIterations` default
10,000, `maxCandidateEvaluations` default 1,000,000). **`#542` above demonstrates those caps are
insufficient** for certain dense-BY-part-plus-small-COUNT rules — a live, currently-unpatched
OOM/DoS vector, not a solved problem.

**Maintenance**: very active — latest **0.27.1** (npm and GitHub tags agree), released shortly
after 0.27.0, both July 2026; roughly ten releases across ~5.5 months (0.25.1 Feb 2026 → 0.27.1 Jul
2026); commits as recent as **2026-09-01**. 5 open issues, 12 open PRs (mostly Dependabot, plus one
substantive pending fix, `#543`). No unmaintained notice — it is, if anything, mid-rewrite, which
cuts both ways: real ongoing investment, but the current codebase is young relative to its
predecessor design, and `#542`/`#544` are exactly the class of regression that follows a rewrite
like this.

**Bundle size / browser usability**: bundlephobia reports **76,058 B gzip** / 241,591 B minified, 2
dependencies. **Confirmed Node-only**: its main entry does `import fs from 'node:fs'`
unconditionally at the top level, and `package.json` carries no `browser` field — it cannot load in
a browser without bundler polyfilling, and even then `parseFile` has nothing to read there.
(`fromURL` internally uses the global `fetch` API rather than Node's `http`/`https`, so that one
function's logic is browser-portable in isolation, but the package as published is not usable
directly in a Client bundle.)

### 2.3 `ical-generator` — generation, actively maintained

[`ical-generator`](https://github.com/sebbo2002/ical-generator) (npm `ical-generator`) generates
`.ics` output — VEVENT, VALARM, and VTIMEZONE-adjacent support — aimed at "subscriptionable
calendar feeds." RRULE is generated either from a plain options object
(`event.repeating({freq: ICalEventRepeatingFreq.WEEKLY, count: 4, ...})` →
`RRULE:FREQ=WEEKLY;COUNT=4`) or by passing an `RRule` object from the `rrule` package directly for
anything more complex than the built-in options cover, per its
[API reference](https://sebbo2002.github.io/ical-generator/develop/reference/classes/ICalEvent.html).

It does **not** generate full `VTIMEZONE` blocks itself. Its own
[README](https://raw.githubusercontent.com/sebbo2002/ical-generator/develop/README.md) says so
directly: *"If a time zone is used, it is also recommended to use a VTimezone generator. Such a
function generates a VTimezone entry and returns it."* The actual `VTIMEZONE` emission is delegated
to an external, optional peer such as `@touch4it/ical-timezones` or `timezones-ical-library` — you
hand `ical-generator` an IANA `TZID` string for each event, and separately wire a VTIMEZONE-
generator callback if the *destination* calendar needs the embedded rule block rather than a bare
TZID reference. `package.json` on `develop` lists `dayjs`, `luxon`, `moment`/`moment-timezone`,
and `rrule` as optional peers for accepted date/recurrence input types, and 0 hard runtime
dependencies.

Maintenance is strong: latest npm version **11.1.1** (2026-08-25, per its CHANGELOG — "encode
property parameter values as defined by RFC 6868"), with a steady cadence through 2025-2026:
11.1.0 (2026-07-24), 11.0.0 (2026-06-02, dropped Node 20/23 support), 10.2.0 (2026-04-17, Apple
Calendar color/travel-time extensions), 10.1.0 (2026-03-15, added Temporal support), 9.0.0
(2025-05-12, added `@date-fns/tz` support). `package.json` pins `"engines": {"node": "22 ||
>=24.0.0"}` and carries no `browser` field — it is written and versioned for Node, not packaged or
documented for direct browser bundling. Bundle size (bundlephobia): **9,374 B gzip** / 37,206 B
minified, 0 hard dependencies.

---

## 3. Recurrence-expansion engines: `rrule` and `rschedule`

### 3.1 `rrule` (rrule.js) — the de facto RRULE engine, RRULE-only

[`rrule`](https://github.com/jkbrzt/rrule) (npm `rrule`) is an RRULE/RRuleSet engine, **not** a
VEVENT or VCALENDAR object model — `rrulestr()` parses an RRULE or an `RRULESET` block
(`DTSTART`/`RDATE`/`EXRULE`/`EXDATE` lines), and `RRuleSet` composes several rules/dates, but
nothing else about a VEVENT (SUMMARY, LOCATION, ATTENDEE, …) is in scope. Its only runtime
dependency is `tslib`.

**RFC coverage** (per its own [README](https://raw.githubusercontent.com/jkbrzt/rrule/master/README.md)):
supports `freq`, `interval`, `wkst`, `count`, `until`, `tzid`, `bysetpos`, `bymonth`, `bymonthday`,
`byyearday`, `byweekno`, `byweekday` (its name for `BYDAY`, ordinals included via
`RRule.MO.nth(2)`), `byhour`, `byminute`, `bysecond` — i.e. the full RFC 5545 RRULE grammar except
`BYEASTER`, which the README states explicitly is a non-standard extension from the Python
implementation and *"Not implemented in the JavaScript version"* (which is fine — `BYEASTER` isn't
in RFC 5545 either). `EXRULE` is supported inside `RRuleSet` but flagged in the README as
"(deprecated in RFC 5545)".

Real bugs, from the tracker directly ([jkbrzt/rrule/issues](https://github.com/jkbrzt/rrule/issues)):
`#375` BYSETPOS breaks with multiple BYDAY values in a monthly rule; `#287` `INTERVAL=0` combined
with BYSETPOS/BYDAY causes an infinite loop; `#320` an unknown timezone can also infinite-loop;
`#580` `between()` measured **10x slower** after a TZID regression (2023); `#621`/`#209`/`#356`
assorted wrong-occurrence reports; `#325` an `RRuleSet` with multiple `RRule`s only honoring the
first under some construction order. DST specifically has several long-open reports: `#233`
("Daily times are wrong around DST when system is not UTC" — occurrences shift an hour after
fall-back, tied to older unresolved `#65`/`#157`/`#213`), `#424` (a rule starting in DST but
landing an occurrence in standard time keeps the DST offset — "date right, time wrong"), and
`#336`/`#452` (users reporting `tzid` appears to make no difference to output) — all still open as
of this research.

**Timezone stance**, quoted directly from the README's "Important: Use UTC dates" section: *"By
default, RRule deals in ... 'floating' times or UTC timezones. ... JavaScript's built-in
'timezone' offset tends to just get in the way, so this library simply doesn't use it at all. All
times are returned with zero offset, as though it didn't exist in JavaScript."* And the
bottom-line warning: *"Returned 'UTC' dates are always meant to be interpreted as dates in your
local timezone. This may mean you have to do additional conversion to get the 'correct' local time
with offset applied."* In plain terms: **every `Date` rrule.js hands back is a UTC-labeled
container for a floating wall-clock value** — it is the caller's job to reattach a real zone. A
`tzid` option exists and uses the platform `Intl` API for genuine IANA-zone generation, and the
README's own worked example shows it correctly handling a fall-back DST transition when `tzid` is
supplied — but the open DST issues above show this isn't uniformly reliable in practice. The README
documents a Luxon recipe for converting rrule.js's floating output to true zoned UTC
(`DateTime.fromJSDate(date).toUTC().setZone('local', {keepLocalTime:true})`); it does not mention
`@date-fns/tz` anywhere.

**All-day / DATE-only**: rrule.js has no documented concept of a date-only value — everything is a
JS `Date` (always a timestamp); an all-day event's date-only semantics are entirely the caller's
responsibility to preserve.

**Bounded expansion**: `all([iterator])` "returns all dates matching the rule," with an `iterator`
callback that can stop early — the README doesn't carry a dedicated bolded warning, but the
implication (an unbounded rule with no `count`/`until` will iterate forever without one) is present
in the prose. `between(after, before, inc, iterator)`, `before(dt, inc)`, and `after(dt, inc)` are
the documented windowed-query methods — this is the shape a 15-year-series-into-one-week query
should use, not `all()`. Caching is on by default (`noCache` opts out) and documented as improving
performance for a reused instance.

**Maintenance**: latest npm version **2.8.1**, published 2023-11-10 — no release in nearly three
years as of this research (2026-09). 3,743 GitHub stars, 212 open issues. Snyk Advisor labels it a
*"Key ecosystem project"* with **2.3M weekly downloads**, "Sustainable" health, but flags directly
that *"it hasn't seen any new versions released to npm in the past 12 months."* No dependents count
could be confirmed from a primary source (npmjs.com's dependents page 403s automated fetches); the
closest corroboration is `ical-generator` accepting an `RRule` instance as an input type and
`rschedule`'s own docs (below) pointing users at rrule.js for anything ICAL-shaped — both consistent
with, but short of proof of, "de facto standard." Bundle size: **13,086 B gzip** / 45,999 B
minified (bundlephobia).

### 3.2 `rschedule` — modular, more capable architecture, but stalled and admittedly RFC-incomplete

[`rschedule`](https://github.com/jorroll/rschedule) (canonical repo on GitLab,
`gitlab.com/john.carroll.p/rschedule` — the GitHub is explicitly a read-only mirror: *"This is a
mirror of the canonical repo located on Gitlab. Issues and merge requests should be created in the
Gitlab repo."*) is architecturally the more interesting design: four composable occurrence-generator
classes (`Rule`, `Dates`, `Schedule`, `Calendar`, all implementing `OccurrenceGenerator`) plus
rxjs-pipe-style operators to combine them, versus rrule.js's single monolithic `RRule`/`RRuleSet`.
It is date-library-agnostic via pluggable `DateAdapter`s — `@rschedule/standard-date-adapter`
(plain `Date`), `@rschedule/luxon-date-adapter`, `@rschedule/moment-date-adapter`,
`@rschedule/moment-tz-date-adapter`, `@rschedule/dayjs-date-adapter`, `@rschedule/joda-date-adapter`
— so real IANA timezone correctness depends entirely on which adapter/date-library is plugged in
(the Luxon and moment-**tz** adapters exist specifically for that; the plain `moment` adapter does
not carry real zone data). rSchedule does not do its own `Intl`-based zone math the way rrule.js's
`tzid` option does.

Full iCalendar `VEVENT` support is an optional add-on, `@rschedule/ical-tools`, and its own docs
are unusually candid about the tradeoff — quoted verbatim from
[the ICAL doc](https://raw.githubusercontent.com/jorroll/rschedule/master/docs/4.%20Serialization/3.%20ICAL.md):
*"Important: If you are only interested in ICAL support, consider using [rrulejs] instead of
rSchedule as it currently has greater support for ICAL recurrence rules."* The same doc: *"Not all
iCal rules are currently supported. `BYWEEKNO`, `BYYEARDAY`, `BYSETPOS` are unsupported"* — a real,
self-admitted RFC 5545 gap, confirmed against the core
[`Rule` options](https://raw.githubusercontent.com/jorroll/rschedule/master/docs/2.%20Usage/2.%20Rule.md)
list, which has no `byWeekNo`/`byYearDay`/`bySetPos` anywhere. `@rschedule/ical-tools` also depends
on `ical.js` as a peer and states plainly: *"Parsing / serializing `VCALENDAR` components is not
currently supported. You can only parse / serialize `VEvent` objects,"* and only `RRULE`, `EXRULE`,
`RDATE`, `EXDATE`, `DTSTART`, `DTEND`, `DURATION` — no `SUMMARY`, `LOCATION`, `ATTENDEE`, etc.

Where it does beat rrule.js: it has an actual, documented all-day/DATE-only mechanism — tagging a
`DateAdapter` with `metadata: {'@rschedule/ical-tools': {isICalType: 'date'}}` forces `VALUE=DATE`
serialization, and `VEvent.fromICal()` round-trips this automatically when parsing an existing
DATE-only VEVENT. And its bounded-expansion API is uniform across every generator type —
`.occurrences({start, end, take, reverse})` returns a lazy `OccurrenceIterator` — rather than one
class's specific method set.

**Maintenance is the deciding problem**: latest npm version across `@rschedule/core`,
`@rschedule/ical-tools`, and `@rschedule/standard-date-adapter` is **1.5.0**, published
2023-02-03. The last commit visible on either the GitHub mirror or via the GitLab API's own
`commits` endpoint is **2023-07-19**. GitLab's `last_activity_at` field shows 2025-07-31, but that
reflects issue/CI activity, not code pushes — no code has shipped since mid-2023. This is
effectively a stalled project as of this research (2026-09), not actively unmaintained-with-notice,
but with no visible signal of continuing development. It has 0 runtime dependencies of its own and
does not wrap rrule.js internally (it reimplements recurrence math from scratch, crediting rrule.js
only for borrowed test cases).

**Bundle size** (bundlephobia): `@rschedule/core` 1.5.0 — 4,472 B gzip; `@rschedule/ical-tools`
1.5.0 — 4,520 B gzip (excludes its `ical.js` peer). Combined core+ical-tools (~9KB gzip) is smaller
than rrule's ~13KB gzip alone, but that comparison undersells rrule.js's completeness — reaching
ical-tools' partial VEVENT/RRULE parity still requires bringing in `ical.js` on top, and even then
it's missing BYWEEKNO/BYYEARDAY/BYSETPOS and any VCALENDAR-level parsing.

---

## 4. Cross-cutting trap: DST and timezone handling

This is where upstream producers genuinely disagree, and it is the single biggest correctness risk
for a Calendar model syncing Google Calendar, CalDAV servers, and Microsoft Graph in that priority
(per [#158](https://github.com/vicvancooten/mail/issues/158)):

- **VTIMEZONE is an embedded, self-contained rule set** (§1.2) — a `TZID` string like
  `"America/New_York"` is only a *label* the producer chose; the actual transition rules that
  govern it live in the `STANDARD`/`DAYLIGHT` sub-components in that same file, and RFC 5545 does
  not require those rules to match the real IANA `America/New_York` data. A producer that dumped
  its VTIMEZONE years ago and never refreshed it, or that only wrote future-facing rules through
  some cutoff year, embeds a silently wrong DST schedule that will only surface once a recurring
  series crosses the point where its embedded rules diverge from reality.
- **What breaks concretely**: none of the surveyed libraries do their own general VTIMEZONE-rule
  interpretation *and* reconciliation against a live IANA database at once — rrule.js's `tzid`
  option leans on the platform's own `Intl` timezone data (i.e. trusts the *label*, ignoring
  whatever rules a VTIMEZONE block actually embeds), while rSchedule delegates entirely to whatever
  date-adapter/library is plugged in. A `.ics` from a CalDAV server or Outlook/Microsoft Graph that
  embeds a genuinely custom or stale VTIMEZONE, then references it by an IANA-looking TZID, is a
  case none of the surveyed libraries verify — they'll happily use the IANA data for that label
  instead of the embedded rules, or vice versa, and nothing here cross-checks the two for drift.
  Google Calendar in practice emits standard IANA TZIDs with the embedded VTIMEZONE kept in sync
  with the real zone, which is the easy case; the risk is squarely with any CalDAV/Graph source
  that doesn't.
- **This is not hypothetical — node-ical's own tracker has a direct, confirmed instance**: issue
  [`#459`](https://github.com/jens-maus/node-ical/issues/459) (closed) reports a moved occurrence in
  a whole-day recurring event working correctly against a **Gmail** export but breaking against an
  **Exchange/O365** export from the same code path — exactly the "Google vs. Outlook" divergence
  this research asked about, confirmed rather than inferred. Issue
  [`#478`](https://github.com/jens-maus/node-ical/issues/478) (closed) is the concrete Outlook/
  Microsoft Graph failure mode: Exchange's non-standard `Customized Time Zone` /
  `tzone://Microsoft/Custom` TZIDs were silently falling back to host-local time instead of reading
  the embedded VTIMEZONE, until node-ical special-cased them. Issue
  [`#544`](https://github.com/jens-maus/node-ical/issues/544) (open, 2026-08-30) is current and
  unresolved: Outlook all-day recurring events in positive-UTC-offset zones (BST/CEST/IST) expand to
  **zero occurrences and silently vanish**. None of this is ical.js- or rrule-specific — it is
  evidence about what real Outlook/Microsoft Graph `.ics` payloads actually contain, and any library
  choice needs test fixtures built from real Graph/Exchange exports, not just Google/CalDAV ones, to
  catch it.
- **Floating time is not "assume local"**: per §1.1, floating means "no zone attached, resolve
  against whatever zone the *viewer* is in right now" — not "the zone the event was authored in."
  A recurring 9am meeting authored as floating should render at 9am for every viewer regardless of
  their zone, and should **not** be converted through any stored offset when the viewer's zone
  changes (e.g. travel, or a DST transition on either side). rrule.js's UTC-labeled-but-actually-
  floating output (§3.1) is exactly the primitive this needs, but only if the caller is disciplined
  about never accidentally re-interpreting one of those values as true UTC.
- **DST-across-a-recurring-series bugs are real and open**, not hypothetical — rrule.js's own
  tracker has multiple long-standing issues (`#233`, `#424`, `#336`, `#452`, §3.1) about occurrences
  landing an hour off around a fall-back/spring-forward boundary specifically when a `tzid` is
  supplied, which is the exact "every day at 9am, cross a DST boundary" case named in the research
  brief.

## 5. Cross-cutting trap: all-day events (VALUE=DATE)

RFC 5545 models an all-day event as a bare date range (§1.3), not an instant. The bug pattern across
implementations, including calendar software generally, is representing an all-day `DTSTART` as
"midnight in timezone X" instead of a genuinely zone-less calendar date — doing that makes the event
appear to shift a day earlier or later depending on which timezone the *renderer* happens to
evaluate "midnight" in, especially right around a DST transition where "midnight local" and "midnight
UTC" diverge by more than the nominal offset for one day a year. Of the two recurrence engines
surveyed, only rSchedule has an explicit, first-class DATE-only representation (`isICalType: 'date'`
metadata, §3.2); rrule.js has none, meaning any DATE-only semantics built on top of it are entirely
the Calendar model's own responsibility to keep correct through every conversion. The parsing
libraries split the same way: `ical.js` exposes a boolean `isDate`/`icaltype` distinction on
`ICAL.Time` (but no `isAllDay()` convenience, open request
[`#353`](https://github.com/kewisch/ical.js/issues/353)), while `node-ical` builds its all-day
values from **local, not UTC, `Date` components** — a source comment states the assumption
outright ("assume same timezone as this computer") — and its own maintainers have had to patch
around the exact day-shift failure mode this produces in at least one code path (its EXDATE-matching
logic), while related breakage is still open elsewhere: issue
[`#544`](https://github.com/jens-maus/node-ical/issues/544) (open) is Outlook all-day recurring
events in positive-UTC-offset zones vanishing entirely, and `#459` (closed) was a whole-day
recurring-event edit that broke specifically against Exchange/O365 exports. Whichever library
handles parsing (§2), the internal Event model this project builds needs its own explicit
"all-day: represented as a plain calendar date, carries no timezone, never gets a time-of-day
attached" invariant independent of what any one library defaults to — none of the surveyed
libraries enforce this correctly and consistently on their own.

## 6. Cross-cutting trap: performance expanding a 15-year series into one week

The RFC's evaluation model (§1.4) is naturally a generator/filter pipeline over one recurrence
period at a time (apply BYMONTH → … → BYSETPOS, then check COUNT/UNTIL), which is inherently
compatible with lazy, windowed iteration — nothing about correct RRULE evaluation requires
materializing every occurrence between 2011 and 2026 to answer "what falls in this one week." Both
engines expose that shape at the API level: rrule.js's `between(after, before)` and rSchedule's
`.occurrences({start, end})` are both windowed-query entry points, not "expand everything, then
filter" — `all()` (rrule.js) is the one call actually documented (if not loudly warned) to be
unsafe for an unbounded rule. No published benchmark specifically measuring "expand a 15-year daily
or weekly rule down to a single week" was found in any surveyed project's docs, issues, or README —
the concrete performance data points that did surface are all negative, and one is a live security
issue rather than a mere slowdown:

- rrule.js issue [`#580`](https://github.com/jkbrzt/rrule/issues/580) reports `between()` itself
  regressing **10x slower** when a `tzid` is present (2023, unresolved as of this research).
- ical.js's own `RecurExpansion` has no convenience windowed method at all
  ([`#148`](https://github.com/kewisch/ical.js/issues/148), open) — a caller must loop `next()`
  manually, and a monthly `BYDAY`+`BYMONTHDAY` combination is internally capped at a 48-month
  search window (an admitted source-level limitation, not a bug report).
- **node-ical's issue [`#542`](https://github.com/jens-maus/node-ical/issues/542) (open,
  security/DoS-rated) is the sharpest data point in this survey**: `expandRecurringEvent()` can
  **OOM a Node process from a sub-1KB YEARLY RRULE** with dense `BY*` lists and `COUNT=1`, because
  the underlying engine (`rrule-temporal`) builds the full BY-part cross-product — up to ~31.5
  million candidates — *before* applying `COUNT`/window filtering, and the library's own documented
  safety caps (`maxIterations: 10000`, `maxCandidateEvaluations: 1000000`) are insufficient to catch
  this shape of rule. This is exactly the failure mode a "15-year recurring calendar expanded to a
  single week" query needs to be defended against: a hostile or merely malformed upstream `.ics`
  (a synced calendar, or an invite email) that encodes a rule this way must not be allowed to
  materialize millions of candidates before any window filter runs, regardless of which library
  ends up doing the expansion. This argues for benchmarking the actual windowed path against
  adversarial as well as realistic RRULE shapes before trusting any library's performance at the
  multi-year-series scale — the bounded-API shape alone does not guarantee bounded *work*.

## 7. Bundle size summary (Client impact)

All figures are bundlephobia minified+gzip unless noted, current as of this research:

| Package | Gzip | Minified | Notes |
|---|---:|---:|---|
| `ical.js` 2.2.1 | 22,807 B | 77,640 B | 0 deps; isomorphic — genuinely usable in a browser bundle |
| `node-ical` 0.27.1 | 76,058 B | 241,591 B | 2 deps (`rrule-temporal`, `temporal-polyfill`); **Node-only** (`node:fs` import, no `browser` field) — not usable in the Client regardless of size |
| `rrule` 2.8.1 | 13,086 B | 45,999 B | 0 hard deps besides `tslib` |
| `@rschedule/core` 1.5.0 | 4,472 B | 14,991 B | 0 deps; needs a date-adapter package on top |
| `@rschedule/ical-tools` 1.5.0 | 4,520 B | 14,515 B | peer-deps on `ical.js`, not included above |
| `ical-generator` 11.1.1 | 9,374 B | 37,206 B | 0 hard deps; Node-pinned (`engines.node: "22 \|\| >=24"`), no `browser` field — not documented for direct browser bundling |
| `@date-fns/tz` 1.5.0 | 2,027 B | 5,622 B | 0 deps; `TZDateMini` variant is smaller still |

Per §9, none of this table should matter for the Client either way — recurrence expansion and
`.ics` parsing/generation both stay server-side, so the Client's bundle carries none of these
libraries at all.

## 8. Temporal and `@date-fns/tz` — the date-arithmetic foundation underneath any of the above

Neither Temporal nor `@date-fns/tz` parses iCalendar or expands RRULEs — they're candidates for the
DST-safe date-arithmetic layer the parsing/recurrence libraries above sit on, or that the Calendar
model uses directly for display/conversion logic outside of recurrence expansion itself.

**Temporal** ([tc39/proposal-temporal](https://github.com/tc39/proposal-temporal)) is at **Stage
4** — the repo's README states this directly: *"This proposal is currently Stage 4."* It is already
shipping natively per the same README: Firefox 139 (May 2025), Chrome 144 (Jan 2026), Node.js 26
(May 2026). For runtimes short of that baseline, the README explicitly steers away from
`@js-temporal/polyfill` for production use — *"DO NOT use this polyfill in your own projects!
Instead, please use a polyfill from the table above"* — naming `temporal-polyfill` (FullCalendar's)
as the stable-release alternative. `Temporal.ZonedDateTime`/`Temporal.PlainDate` give calendar-aware,
DST-safe arithmetic and a first-class distinction between a zoned instant and a plain (floating)
date — which maps directly onto RFC 5545's three DATE-TIME forms (§1.1): `Temporal.Instant` for
UTC, `Temporal.ZonedDateTime` for TZID-qualified, `Temporal.PlainDateTime`/`PlainDate` for floating
and all-day, respectively. This is architecturally the cleanest fit for the RFC's own model, gated
only on Node baseline.

**`@date-fns/tz`** ([date-fns/tz](https://github.com/date-fns/tz), npm `@date-fns/tz`) provides
`TZDate`/`TZDateMini`, `Date` subclasses that perform all calculations in a given IANA zone or fixed
offset rather than the system zone, plus a `tz()` context helper making date-fns comparison
functions zone-aware "starting from date-fns@4." Latest release 1.5.0 (2026-05-21), active
cadence (six releases across 2024-2026), 0 dependencies, 2,027 B gzip. This is the pragmatic,
materially lighter-weight option today if the codebase is already on date-fns v4 and not ready to
adopt Temporal (or a polyfill) — real IANA-zone-aware `Date`-like objects without a new type
system, at the cost of being date-fns-ecosystem-specific rather than a language-level primitive.

**What rrule.js and rschedule themselves recommend pairing with**: rrule.js's README recommends
**Luxon** by name for converting its floating/UTC-labeled output into true zoned values (a
documented `DateTime.toUTC().setZone('local', {keepLocalTime: true})` recipe) — it does not mention
`@date-fns/tz` anywhere in its current README. rSchedule ships dedicated Luxon and moment-**timezone**
(not plain moment) date-adapters specifically for real zone support, alongside a plain-`Date`
adapter with no zone awareness at all. Across both libraries, **Luxon** — not dayjs+plugin, not
`@date-fns/tz`, not Temporal — is the consistently name-checked companion for genuine timezone
correctness, which is worth noting as the path of least resistance if either library is adopted as-is,
even though Temporal/`@date-fns/tz` are individually more modern choices for net-new code that isn't
constrained by what these two libraries' own docs demonstrate.

---

## 9. Recommendation

**Sync Backend: `ical.js` for parsing and generating full `.ics`/`VEVENT` structure, `rrule`
(paired with Luxon) for the actual recurrence-rule expansion — not `ical.js`'s own recurrence
engine, not `node-ical`, not `rschedule`.**

This is a deliberately mixed stack, and each half of it is a rejection of a simpler-looking
alternative for a concrete, sourced reason:

- **Not `node-ical` for parsing**, despite being the more RFC-complete-*looking* option in its
  RRULE handling (it delegates that to `rrule-temporal`): it is **parser-only** (no generation
  path at all, and #158 commits to local calendars generating their own iMIP invites), it is
  **missing `RDATE` support entirely** (not found anywhere in its parsing dispatch table — a real
  RFC 5545 §3.8.5.2 gap), it is **Node-only** by construction (unconditional top-level `node:fs`
  import, no `browser` field — moot for a backend-only choice, but confirms it could never also
  serve an isomorphic use case the way `ical.js` can), and, most importantly, it just underwent a
  major rewrite (CJS→ESM, `rrule`→`rrule-temporal`, mid-2026) that has already produced one shipped
  regression (`#499`, fixed) and currently carries **two open, unfixed issues that are exactly the
  traps this research was asked to find**: a security-rated OOM/DoS on dense RRULEs
  ([`#542`](https://github.com/jens-maus/node-ical/issues/542)) and Outlook all-day events silently
  vanishing ([`#544`](https://github.com/jens-maus/node-ical/issues/544)). Its timezone-divergence
  issue history (§2.2, §4) is genuinely the most useful primary evidence in this whole survey for
  what breaks against real Outlook/Graph payloads — worth mining as a test-fixture source — but that
  doesn't make the library itself a safe dependency to build on right now.
- **Not `rschedule`**: no code pushed since mid-2023 (§3.2), and its own docs say to prefer
  `rrule.js` for anything RFC-5545-complete — a rare case of a library's own maintainers pointing
  away from it for exactly this use case.
- **`ical.js` for parsing and generation**: it is the only survey candidate that models the full
  `VCALENDAR`/`VEVENT` object graph (not just an RRULE fragment), which the RFC 5546 iTIP triad
  (`UID`/`SEQUENCE`/`RECURRENCE-ID`, §1.5) and the full property set (`ATTENDEE`, `ORGANIZER`,
  `SUMMARY`, `LOCATION`, …) both require — `rrule` and `rschedule` are both explicitly
  RRULE/VEVENT-fragment engines, not VCALENDAR parsers. It round-trips (`stringify.js`) so the same
  library that parses an inbound invite can generate an outbound one, it has zero runtime
  dependencies, and it is actively (if modestly) maintained with commits as recent as 2026-09-04.
  `ical-generator` (§2.3) remains a reasonable alternative purely for the generation half if a
  higher-level, feed-oriented construction API is preferred over building `jCal` objects by hand —
  it is more actively released and, notably, already accepts an `RRule` instance directly as input,
  which composes with the recurrence choice below either way.
- **`rrule`, not `ical.js`'s own `RecurExpansion`, for the actual recurrence math**: `ical.js`
  parses an RRULE property correctly, but its own expansion engine has real, admitted gaps —
  BYWEEKNO unimplemented for a standalone yearly rule, a 48-month internal cap on monthly
  BYDAY+BYMONTHDAY combinations, an open BYSETPOS bug on certain monthly rules
  ([`#960`](https://github.com/kewisch/ical.js/issues/960), unmerged fix pending), and no
  convenience windowed-query method at all ([`#148`](https://github.com/kewisch/ical.js/issues/148),
  open — you'd have to hand-loop `next()` to get a bounded window). `rrule` is the more complete,
  more heavily used and tested engine for this specific job: full BYxxx grammar including
  BYSETPOS/BYWEEKNO/BYYEARDAY, first-class `between()`/`before()`/`after()` windowed-query methods
  (§3.1, §6 — exactly the "15-year series into one week" shape), 2.3M weekly downloads and a
  "sustainable" health rating despite no release since 2023, and it's the library `rschedule`'s own
  maintainers point to and `ical-generator` already accepts as a first-class input type — the
  closest thing this survey found to a de-facto standard. Feed `ical.js`'s parsed
  `DTSTART`/`RRULE`/`EXDATE`/`RDATE` values into an `rrule` `RRuleSet` for expansion, and pair it
  with Luxon per rrule's own documented recipe (§8) to reattach a real IANA zone to its
  floating/UTC-labeled output rather than trusting its bare `Date` return values as true UTC.
- Model the RFC 5545 DATE-TIME distinctions explicitly in the Calendar model's own internal Event
  type — floating vs. UTC vs. TZID-qualified, and DATE-only for all-day — rather than collapsing
  them into one `Date`/timestamp field anywhere in the pipeline; that distinction is what both
  §4 and §5's traps come from, and no surveyed library enforces it for you end-to-end.
- Treat Temporal as the long-term target for internal date arithmetic once the Sync Backend's Node
  baseline reaches native support (or via `temporal-polyfill`, never `@js-temporal/polyfill` in
  production per its own README); `@date-fns/tz` is a reasonable nearer-term stand-in if the
  codebase is already on date-fns v4 and Temporal isn't ready yet. Neither replaces `rrule` for
  RRULE evaluation itself — they solve zone-safe arithmetic, not the BYxxx grammar.

### What the Client needs — nothing, by construction

**The Client should never run recurrence expansion, and should not import `rrule` or `ical.js`
into the browser bundle at all.** This follows directly from the architecture already settled in
[ADR-0010](../adr/0010-store-as-truth-with-a-pending-mutation-overlay.md) and
[#158](https://github.com/vicvancooten/mail/issues/158), not from anything specific to these
libraries:

- The Sync Backend already holds the full mirror of each synced calendar and is the single
  source of truth (#158's "Mirror with upstream-wins"); the Client's Local Cache is a disposable,
  overlay-computed projection of server state (ADR-0010, and
  [ADR-0009](../adr/0009-client-local-cache-is-a-disposable-indexeddb-cache.md)), not an independent
  copy of raw `.ics`/RRULE data that needs its own expansion logic.
  Recurrence expansion is exactly the kind of derived, recomputable-from-truth state ADR-0010
  argues should live server-side and sync as data, the same way message search
  ([ADR-0016](../adr/0016-search-runs-in-the-sync-backend-over-a-bounded-candidate-window.md))
  runs in the Sync Backend over a bounded window rather than duplicating an index into every
  Client.
- The Sync Backend should expand each mirrored series into concrete occurrence rows for whatever
  bounded window the delta protocol
  ([ADR-0011](../adr/0011-one-delta-endpoint-with-per-collection-state-tokens.md)) is currently
  syncing to a Client — the same "windowed, not materialize-everything" shape `rrule`'s `between()`
  and `rschedule`'s `.occurrences({start, end})` both already expose at the library level (§6) —
  and ship those rows as plain data. A day/week/month view then never needs to know a RRULE exists;
  it renders rows like any other synced collection, through the same `liveQuery` + `base ⊕ pending`
  overlay every other App already uses.
  - This also sidesteps every trap in §4/§5 entirely for the Client: it never resolves a floating
    time, never interprets a VTIMEZONE block, never decides what "all-day" means across a DST
    boundary — the Sync Backend resolves each occurrence to a concrete, already-zoned instant (or an
    explicit all-day date) once, and the Client only ever renders that resolved value.
  - The one caller-visible exception: rendering an occurrence that is genuinely **floating** (§1.1)
    still needs the *Client's own current zone* at render time, not a zone baked in server-side at
    sync time — the Sync Backend should ship the occurrence's wall-clock value and an explicit
    "floating" flag rather than a resolved instant for that case, so a Client that has since
    travelled renders it correctly without a resync. This is a payload-shape decision for the
    Calendar sync-protocol spec, not a recurrence-library decision.
  - A locally-created (non-synced) recurring event still only ever needs the Sync Backend's
    expansion, once it's written there — per #158, "Local calendars exist in v1" but nothing in that
    decision implies Client-side expansion; a locally-created series is itself mirrored and expanded
    the same way as an upstream one, per store-as-truth.
- Net effect: zero bundle-size cost in the Client for any of §2/§3/§7's libraries, and zero risk of
  the Client and Sync Backend disagreeing about what a recurring series expands to, which a
  Client-side second expansion engine would otherwise risk (e.g. a Client on an older cached
  `rrule` build disagreeing with the Sync Backend's after a DST-bug fix like §3.1's `#233`/`#424`).
