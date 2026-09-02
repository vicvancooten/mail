# iOS PWA Web Push & App Badging constraints

Research for [issue #26 "Verify iOS PWA Web Push & App Badging
constraints"](https://github.com/vicvancooten/mail/issues/26) (child of [#1, the wayfinder
map](https://github.com/vicvancooten/mail/issues/1)).

Question: [ADR-0015](../adr/0015-realtime-is-sse-hints-plus-web-push.md) ("Real-time delivery is SSE
hints to open Clients and Web Push to closed ones") load-bears three iOS claims that were asserted
from memory while resolving #17 and never checked against a primary source: that Web Push requires
Home Screen installation, that `navigator.setAppBadge` works for installed iOS web apps, and that
notification action buttons are unsupported on iOS (the reason Archive/Approve/Block are
Android-only in the design). The design also silently assumes three more things: that an installed
PWA's service worker isn't evicted aggressively enough to lose a `PushSubscription`, that
`clients.matchAll({type:'window'})` reliably reports a visible window from inside a service worker on
iOS, and that Background Sync's absence on iOS is total (no retry path at all for offline notification
actions there).

This document checks all six against Apple's own developer documentation, the WebKit blog, WebKit's
own shipped source, and WebKit's bug tracker and standards-positions repo — not secondary
write-ups repeating each other. Where Apple has published nothing on a point, that is stated plainly
rather than filled in with a plausible-sounding guess. `developer.mozilla.org` is used in a couple of
places only as a pointer to the primary source it cites, never as the source of a claim about
Apple/WebKit's own behavior.

---

## 1. Web Push requires Home Screen installation

**Confirmed, with a version and one real caveat.** [WebKit's own announcement post](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
states it directly: "Now with iOS and iPadOS 16.4, we are adding support for Web Push to Home Screen
web apps." The companion [Safari 16.4 features roundup](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)
repeats it: "iOS and iPadOS 16.4 add support for Web Push to web apps added to the Home Screen." A
plain Safari tab on iOS gets no Push API access at all — this is iOS/iPadOS-specific; on **macOS**,
Apple's own [Web Push developer documentation](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
frames the requirement as "Add web push to Home Screen web apps in iOS 16.4 or later and Webpages in
Safari 16 for macOS 13 or later" — i.e. macOS Safari never required installation, only iOS did. So
the ADR's claim is correct for the platform it's written for (this is a Client running on phones,
per the product framing), version-attributable to **iOS/iPadOS 16.4** (March 2023).

### What happens to the subscription on uninstall

**Not directly documented by Apple, and the honest answer is "we don't fully know."** Three things
are confirmed and one important thing is not:

- The **standard Web Push protocol** (which Apple's own docs describe implementing, not a
  proprietary APNs binary format) is explicit here: [RFC 8030 §7.3](https://www.rfc-editor.org/rfc/rfc8030)
  states "A push service MUST return a 404 (Not Found) status code if an application server attempts
  to send a push message to an expired push message subscription," and §6.2 requires a 410 (Gone)
  when the push service gives up retrying a message before its TTL expires. This is the standards
  basis for ADR-0015's "pruned on the first 404/410" behavior.
- Apple's own documentation for its web push service **corroborates the codes but not the trigger**:
  its status-code table lists `404` as "The request contains an invalid `:path` value" and `410` as
  "The device token has expired" — real, documented responses — but nowhere does Apple's page state
  that *removing the web app from the Home Screen* is one of the events that produces them. The
  causal link ("uninstall → subsequent push gets 404/410") is a reasonable inference from how the
  rest of the ecosystem behaves, not a sentence Apple has written down.
- **`pushsubscriptionchange` does not fire reliably on iOS.** An unanswered [Apple Developer Forums
  thread](https://developer.apple.com/forums/thread/727372) has a developer reporting exactly this
  gap directly to Apple: "It seems that PWA push notifications on iOS are being revoked outside of
  user interaction... This is a critical failing of PWA push notifications on iOS, especially given
  that the `pushsubscriptionchange` event is not supported," and separately asking "In general, does
  Apple have a policy on when it invalidates push subscription objects?" — a question that, as of
  this research, has **no Apple engineer or DTS response** in the thread, only another developer's
  workaround suggestion. A second independent report ([XenForo community
  thread](https://xenforo.com/community/threads/lost-push-subscriptions-for-ios-pwa.215833/)) surfaced
  in search results but returned HTTP 403 and could not be verified directly in this pass.

**Net verdict on the sub-question**: the *server-side* half (404/410 as the standard, documented way
a push service signals a dead subscription) is solid, standards-backed and confirmed. The
*iOS-uninstall-triggers-it* half is **not Apple-documented at all**, and the one place a developer
asked Apple directly went unanswered — meaning "the backend prunes on 404/410" is the right design
regardless, but relying on that path firing *promptly* after every uninstall (rather than sometime
later, or never, until the next scheduled push attempt) is unverified. This is closer to "probably a
black hole for a while, not a guaranteed instant signal" than either of the two options the ticket
posed.

---

## 2. App Badging (`navigator.setAppBadge`)

**Confirmed, same version as Web Push, and yes — it survives full closure.** [WebKit's Badging
announcement](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/) states: "In iOS and
iPadOS 16.4, the Badging API is available exclusively for web apps the user has added to their home
screen. The API is not exposed to websites in Safari or other browsers, or in any app that uses
WKWebView" — so, like Web Push, this is Home-Screen-only and shipped in the same release,
**iOS/iPadOS 16.4**.

On persistence: the **W3C Badging API spec itself** — the standard WebKit implements — states this
outright: "If multiple API calls within the same application set or clear a badge, the most recent
one takes effect, and **may continue being seen even after an application is closed**" ([Badging API
spec](https://w3c.github.io/badging/)). The spec frames the badge as OS-owned state the user agent
merely relays, not app-runtime state: "the operating system stores and manages the badge value, with
the user agent acting as an intermediary," with one honest hedge — "The user agent or operating
system MAY clear a badge at its discretion... (for example, when the system is reset)." WebKit's own
post corroborates the "doesn't need the app running" half from the other direction: `setAppBadge`/
`clearAppBadge` work "while the user has the web app open in the foreground **or while the web app is
handling push events in the background**" and the Badging API "is exposed in Web Worker contexts,"
explicitly so a service worker can update the badge from a push event with no window open at all.

One real gate worth carrying into the design: "The badge will only appear if the user has granted
notifications permission" — badging alone, without notification permission, is invisible even though
the API calls succeed silently.

---

## 3. Notification action buttons on iOS

**Still true, and now confirmed at the strongest level available: WebKit's own shipping source.**
Fetched directly from the `main` branch of [github.com/WebKit/WebKit](https://github.com/WebKit/WebKit)
(checked 2026-08-31, i.e. against what ships in Safari 26.6/27 beta):

- [`Source/WebCore/Modules/notifications/NotificationOptions.idl`](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/notifications/NotificationOptions.idl)
  defines the dictionary passed to `showNotification()` with exactly `dir`, `lang`, `body`,
  `navigate` (Declarative-Web-Push-only), `tag`, `icon`, `silent`, `data` — **no `actions` member at
  all**.
- [`Source/WebCore/Modules/notifications/Notification.idl`](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/notifications/Notification.idl)
  shows the read-back side has the same shape *deliberately left out, not merely never added*: the
  line `// [SameObject] readonly attribute FrozenArray<NotificationAction> actions;` and
  `// static readonly attribute unsigned long maxActions;` are present in the source **as comments**,
  meaning WebKit engineers scaffolded the spec's shape and left it disabled.

Since WebIDL dictionaries silently drop unrecognized members rather than throwing, a Client that
passes `actions: [...]` to `showNotification()` on iOS today gets no error and no buttons — exactly
the failure mode that makes this easy to ship un-noticed without a real device test.

This is corroborated by an open, currently-worked WebKit bug: [bug
268797](https://bugs.webkit.org/show_bug.cgi?id=268797), "notificationclick events in serviceworkers
not firing," status **NEW**, most recent comment **2026-08-12** (i.e. this week, relative to this
research) — meaning the whole click-handling path this feature would need is independently unreliable
on iOS even before action buttons are considered (detailed further in §5).

The one adjacent, real feature WebKit *has* shipped is **not** the same thing: [Declarative Web
Push's `actions`](https://github.com/WebKit/explainers/blob/main/DeclarativeWebPush/README.md) lets a
push payload declare `{action, title, url}` entries, but activating one just **navigates to that URL**
directly — it explicitly "bypasses the `notificationclick` event handler entirely," so there is no
way for a tap to `POST` an Archive/Approve/Block intent to the backend the way ADR-0015's design
needs; it can only open a page. The explainer itself flags this as unfinished business: "we're
considering ways to support an action opening a URL directly *combined* with that data being exposed
to JavaScript" — i.e. even Apple's own team treats "action button that also runs your JS" as an open
design question, not a shipped capability.

**Verdict: still true as of the current release.** No WebKit source, bug, or release note found in
this research shows action buttons implemented, in progress with a target version, or even
publicly requested by Apple — this is a quiet, deliberate non-implementation, not a recent regression
or a near-term roadmap item.

---

## 4. Service worker lifetime / eviction for installed PWAs

**Documented, and more of a real risk than the ADR assumes — Apple's own team calls it out as
something they had to design around.** Two WebKit primary sources, five years apart, tell a slightly
inconsistent story that is itself informative:

- **2020, ITP 2.3**: [WebKit's Intelligent Tracking Prevention 2.3
  post](https://webkit.org/blog/9521/intelligent-tracking-prevention-2-3/) describes the general "cap
  on script-writable storage" (7 days of non-use) and states plainly that installed web apps are
  meant to be exempt in practice: "Web applications added to the home screen are not part of Safari
  and thus have their own counter of days of use. Their days of use will match actual use of the web
  application... If your web application does experience website data deletion, it would be
  considered **a serious bug**."
- **2025, Declarative Web Push**: [WebKit's own announcement post](https://webkit.org/blog/16535/meet-declarative-web-push/)
  (published 2025-03-27, targeting iOS/iPadOS 18.4) lists this as "Challenge 2 — Tracking data" that
  the *entire feature* was partly built to route around: **"ITP deletes all website data for websites
  you haven't visited in a while. This includes service worker registrations,"** going on to say "ITP
  removing a service worker registration would render the push subscription useless" — stated as a
  real, current problem, with no caveat that installed Home Screen apps are exempt from it. No
  concrete day/week count is given in this post.

Declarative Web Push's actual fix is to **decouple the push subscription from the service worker
entirely** — subscriptions now live on `window.pushManager` and, per the same post, "the removal of
[a] service worker registration will not affect the associated push subscription" once a site
opts into the declarative model. That is a strong, direct admission that under the *old* (and still
default, for anyone not adopting Declarative Web Push) model, **losing the service worker did lose
the subscription's usefulness** — which is exactly the risk item ADR-0015 leaves unverified. Apple
built a new API specifically because this was a real enough problem to solve, not a hypothetical.

**Verdict**: the eviction risk is real and Apple-documented, though the exact trigger window for an
*actively-installed, occasionally-opened* app is not given a number anywhere found in this research
— the 2020 post's "your own counter of days of use, reset by actual use" framing is the closest thing
to a mitigating mechanic, but the 2025 post's plain "this includes service worker registrations"
statement, offered with no such caveat, suggests it isn't airtight in practice.

---

## 5. `clients.matchAll({type:'window'})` reliability on iOS

**Not reliable, and this is not a hunch — it's WebKit's own bug tracker, actively worked on this
week.** Two directly relevant, primary-source bugs:

- [**Bug 268797**](https://bugs.webkit.org/show_bug.cgi?id=268797), "notificationclick events in
  serviceworkers not firing" — status **NEW**, affected versions iOS 16.4 through 18.7 (still
  reproducing), component Service Workers, priority P2/Major. WebKit engineer **Ben Nham** commented
  (2024-09-10) that beyond the headline click-handling bug, "**it sounds like some `Clients` and
  `WindowClient` methods resolve too early**," and split that observation into two dedicated
  follow-ups: [bug 279458](https://bugs.webkit.org/show_bug.cgi?id=279458) for
  `WindowClient.matchAll` specifically, and bug 279456 for `Clients.openWindow`. The most recent
  comment on 268797 is dated **2026-08-12** — this week relative to this research — and is still
  actively diagnosing a root cause ("the web clip identifier: (null) correlates with every failed
  activation"), i.e. this is not stale or abandoned.
- [**Bug 279458**](https://bugs.webkit.org/show_bug.cgi?id=279458), "WindowClient.matchAll resolves
  promise too early" — **RESOLVED FIXED**, landed 2024-10-31 (commit `285953@main`), described as:
  "Devs are reporting that WindowClient.matchAll sometimes resolves its promise too early, e.g.
  trying to postMessage to a matched client sometimes fails." The fix filters out clients whose
  "execution ready flag" isn't yet set, matching Chrome's behavior. No comment states which shipped
  Safari version first carried the fix.

Net picture: WebKit has actively worked on and partially fixed `matchAll`-adjacent timing bugs, but
the broader class of bug (a service worker's view of its window `Clients` being wrong or late,
specifically in the push/notification-triggered wake-up path ADR-0015's toast-vs-OS-notification
decision runs on) has an **open, unresolved, currently-active** WebKit bug as its umbrella tracker.
There is no WebKit or Apple documentation asserting `clients.matchAll({type:'window'})` is reliable
from inside a push event handler on iOS — what exists is a bug tracker showing engineers still
chasing timing bugs in exactly that code path as of last week.

---

## 6. Background Sync API on iOS Safari

**Confirmed absent, and not a version gap — WebKit has never taken a position on it.**
[WebKit/standards-positions issue #14](https://github.com/WebKit/standards-positions/issues/14),
"Web Background Synchronization (BackgroundSync)," currently carries the status **"Needs position"**
and is tagged with **power concerns** and **privacy concerns** — meaning WebKit's own standards
process has not even reached a stated yes/no on the spec, let alone shipped it. This is a
Google-originated, WICG-incubated proposal with adoption limited to Chromium-family browsers.
Consistent with this, no Safari release note (16.4 through 26.6, or the 27 beta) surveyed in this
research mentions Background Sync, and it does not appear in any WebKit-authored blog post found.

**Verdict**: ADR-0015's own parenthetical — "registers a Background Sync tag if offline
(Chrome/Android-only, which is where the priority is)" — is correct and, if anything, understates the
gap: this isn't "iOS is behind," it's "iOS has no expressed intent to ever have this," per WebKit's
own tracking issue. There is no retry mechanism at all on iOS Safari for an offline notification
action; a failed `POST` from the service worker on iOS is simply a failed `POST`, full stop, unless
the ADR's own fallback ("re-shows the notification on hard failure") is what actually carries the
retry burden there — which the ADR text doesn't say explicitly one way or the other.

---

## Verdict

**Claim 1 — "Web Push on iOS requires Home Screen install, no push from a Safari tab."**
**Confirmed as written**, version-attributable to iOS/iPadOS 16.4
([source](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)). No amendment
needed to the ADR's core claim. What the ADR states as settled and *isn't* — "**pruned on the first
`404`/`410` from the push service**" — is standards-correct as a design (RFC 8030 backs the codes
exactly) but the assumption that an *uninstall specifically* reliably and promptly produces one of
those codes is **unverified by Apple**, and the one place a developer asked Apple this exact question
directly went unanswered. Recommend softening this ADR line from an implied "prompt, guaranteed
signal" to something that names the uncertainty — e.g. noting that pruning may lag an uninstall by an
unknown, possibly long interval (bounded only by however often the backend attempts a push to that
Mail Account) rather than firing immediately, since nothing in Apple's documentation promises
otherwise.

**Claim 2 — "App Badging works for installed iOS web apps."**
**Confirmed as written, including the unstated half.** iOS/iPadOS 16.4
([source](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)), and the badge does
survive full app closure — this is in the W3C spec's own text, not an inference
([source](https://w3c.github.io/badging/)). No amendment needed to ADR-0015 for the badging claim
itself. However, see "Other findings" below — the *mechanism* the ADR assigns for setting the badge
does need amending, even though the underlying platform claim is correct.

**Claim 3 — "Notification action buttons are unsupported on iOS, hence Android-only."**
**Confirmed as written, and confirmed at the strongest possible level** — WebKit's own shipping IDL
source has the `actions` member absent from `NotificationOptions` and commented out (not merely
unimplemented) in `Notification.idl`
([source](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/notifications/NotificationOptions.idl)).
No amendment needed. The ADR's exact text — "**Action buttons post directly to the API... registers a
Background Sync tag if offline (Chrome/Android-only, which is where the priority is)**" — holds up
completely: both the buttons themselves and their offline-retry mechanism are Chrome/Android-only for
independently confirmed reasons (§3, §6).

---

## Other findings worth flagging (outside the six questions)

While reading ADR-0015 end to end against what this research turned up, three more places look
shakier than the ADR treats them:

1. **The badge-update mechanism the ADR names can't reach the one case iOS badging exists for.**
   ADR-0015 says: "The app-icon badge... [is] set by the leader tab on every delta." But the leader
   tab, by definition, only exists when a Client window is open — and Web Push (§1) exists precisely
   *because* iOS gives you nothing when no window is open. WebKit's own Badging post is explicit that
   the API's value for push-driven apps comes from calling `setAppBadge` **from the service worker
   while handling a push event**, with no window involved at all
   ([source](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)). If the badge is only
   ever touched by a leader tab, an iOS user who never has the PWA open sees new-mail *notifications*
   land (via push) but the badge count never moves until they next open the app — the opposite of how
   native iOS badges behave, and a gap this ADR doesn't name. The service worker's push handler needs
   its own path to call `setAppBadge`, not just relay through the leader tab.

2. **Safari's silent-push penalty is harsher than the one the ADR's "tickle-only pushes" argument
   considers, and cuts against the Notifier's own design, not just against tickles.** ADR-0015
   rejects tickle-only pushes solely on the grounds that "Chrome requires `userVisibleOnly`." WebKit's
   Declarative Web Push post reveals Safari's version of this rule is stricter and has a bigger
   blast radius: "bugs in a service worker script, networking conditions, or local device conditions
   all might prevent a timely call to `showNotification`" and when that happens **WebKit revokes the
   push subscription outright** ("Challenge 1," [source](https://webkit.org/blog/16535/meet-declarative-web-push/)) —
   not just a bad single notification, the *whole subscription* dies. This matters beyond the
   tickle-vs-payload decision the ADR already made correctly: it means any bug, timeout, or crash in
   the Notifier's own service-worker-side push handler (not just a deliberate tickle design) risks
   silently unsubscribing an iOS device the first time it happens, with no documented grace period.
   Worth a defensive note in the ADR or in implementation: the push handler must be unusually robust
   about *always* calling `showNotification` even in an error path, specifically because iOS's
   penalty for skipping it is subscription death, not just a missed notification.

3. **SSE reliability while an iOS PWA is backgrounded (not closed) is asserted, not verified, and
   this research could not close the gap.** ADR-0015's whole two-channel design rests on "SSE to
   Clients that are open, Web Push to Clients that are not" — but it never addresses the case of a
   Client that's open but *backgrounded* (user switched apps briefly). General iOS behavior
   throttles/suspends background web content aggressively, which would push a backgrounded-but-not-
   closed PWA's long-lived SSE connection toward the "missed heartbeat → polling floor" path sooner
   than a desktop tab would ever hit it. This research found no WebKit or Apple primary source stating
   a concrete timeout for background SSE/EventSource connections specifically (as opposed to native
   app background execution, which is well documented but a different mechanism) — flagging this as
   an open question rather than asserting a number, since no primary source backing a specific figure
   could be found.

---

## Sources consulted

- [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [WebKit: WebKit Features in Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)
- [WebKit: Badging for Home Screen Web Apps](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)
- [WebKit: Meet Web Push](https://webkit.org/blog/12945/meet-web-push/)
- [WebKit: Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)
- [WebKit: WebKit Features in Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)
- [WebKit: Intelligent Tracking Prevention 2.3](https://webkit.org/blog/9521/intelligent-tracking-prevention-2-3/)
- [Apple Developer Documentation: Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- [Apple Developer Documentation: Safari Release Notes (index)](https://developer.apple.com/documentation/safari-release-notes)
- [Apple Developer Forums thread 727372 — push subscription validity policy](https://developer.apple.com/forums/thread/727372)
- [Apple Developer Forums thread 735307 — service worker lifetime/thermal state](https://developer.apple.com/forums/thread/735307)
- [WebKit/WebKit source: `NotificationOptions.idl`](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/notifications/NotificationOptions.idl)
- [WebKit/WebKit source: `Notification.idl`](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/notifications/Notification.idl)
- [WebKit/explainers: Declarative Web Push explainer](https://github.com/WebKit/explainers/blob/main/DeclarativeWebPush/README.md)
- [bugs.webkit.org #268797 — notificationclick events in serviceworkers not firing](https://bugs.webkit.org/show_bug.cgi?id=268797)
- [bugs.webkit.org #279458 — WindowClient.matchAll resolves promise too early](https://bugs.webkit.org/show_bug.cgi?id=279458)
- [WebKit/standards-positions #14 — Web Background Synchronization](https://github.com/WebKit/standards-positions/issues/14)
- [W3C Badging API specification](https://w3c.github.io/badging/)
- [RFC 8030 — Generic Event Delivery Using HTTP Push](https://www.rfc-editor.org/rfc/rfc8030)
