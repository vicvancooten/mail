# HTML email rendering & sanitization

Research for the Reading section of [the PoC scope](../poc-scope.md), which commits to "Sanitized
HTML rendered in a sandboxed iframe. Remote images blocked by default and loaded automatically for
Approved Senders — the Gatekeeper verdict *is* the image-loading permission," held against the
acceptance bar's `< 100ms` thread-open target, "served from the local store — never a network wait,"
against a seeded 250,000-message / 80,000-thread corpus.

Question: reading real mail at PoC means rendering hostile marketing/phishing HTML safely, in a
Client that is a React + Vite PWA caching message bodies locally and offline-first
([ADR-0002](../adr/0002-react-vite-spa-client.md)), served by a TypeScript/Node/Fastify Sync Backend
([ADR-0005](../adr/0005-typescript-sync-backend.md)) that already owns App Feature state including
Gatekeeper verdicts ([ADR-0006](../adr/0006-app-feature-state-lives-in-sync-backend.md)). What do
other real mail clients and libraries actually do — sourced to specs, official docs, source repos,
and security advisories, not blog summaries of them — and what pipeline does that argue for here.

This document does not fabricate sources. Where a claim isn't publicly documented (Gmail's mobile
dark-mode color-rewrite algorithm, Apple Mail's exact auto-darkening heuristic), it says so plainly
instead of citing something unverifiable.

---

## 1. Sanitizer choice: DOMPurify, sanitize-html, or both

### DOMPurify's own threat model

[DOMPurify's README](https://github.com/cure53/DOMPurify) describes itself as "a DOM-only,
super-fast, uber-tolerant XSS sanitizer for HTML, MathML and SVG." Its linked [Security Goals &
Threat Model](https://github.com/cure53/DOMPurify/wiki/Security-Goals-&-Threat-Model) wiki page
states its concrete goals as preventing XSS, DOM clobbering, XSS via jQuery, structural damage, and
prototype pollution, and it maintains a dedicated
[Attack Classes & Bypass History](https://github.com/cure53/DOMPurify/wiki/Attack-Classes-&-Bypass-History)
page cataloguing mutation-XSS, namespace-confusion, and parser-mutation exploit classes it hardens
against.

Two things it explicitly does **not** cover matter directly for email. First, markup-context
flipping: sanitized HTML fed into an SVG/MathML/attribute/rawtext sink can reopen exploitability, so
the sanitized string must land exactly where it was sanitized for (an HTML document context, here).
Second — and load-bearing for this project — **DOMPurify does not sanitize CSS by default and does
not block requests to external resources**: its default allowed-tags list (`src/tags.ts` in the
DOMPurify repo) includes `style`, and its default allowed-attributes list (`src/attrs.ts`) includes
the `style` attribute for both the `html` and `svg` profiles. A tracking-pixel `background:
url(https://sender.example/t.gif)` in an inline `style` attribute survives default DOMPurify output
untouched — sanitization and remote-content blocking are separate concerns this project must handle
as two different mechanisms (§3), not one.

Config options that matter for a mail client, per the README: `ALLOWED_TAGS`/`ALLOWED_ATTR` (allowlist,
the recommended posture over denylisting via `FORBID_TAGS`/`FORBID_ATTR`); `ALLOWED_URI_REGEXP`,
whose *default* value permits `cid:`, `mailto:`, `tel:`, `sms:`, `xmpp:`, and `http(s):` schemes —
useful since `cid:` needs to survive to be resolved (§4), but the default is broader than a mail
client wants and should be tightened to exactly the schemes it plans to handle; `WHOLE_DOCUMENT`
(default `false`), relevant because email HTML frequently arrives as a full `<html>`/`<head>`
document; and `SANITIZE_DOM` (default `true`, DOM-clobbering protection — the README documents
turning it off as the dangerous direction, never the safe one).

DOMPurify explicitly documents running server-side under Node via jsdom, with a code sample in the
README (`const { JSDOM } = require('jsdom'); const window = new JSDOM('').window; const DOMPurify =
createDOMPurify(window);`) — directly relevant since the Sync Backend is Node. The README carries a
pointed caveat right next to that sample: "older versions of jsdom are known to be buggy in ways
that result in XSS even if DOMPurify does everything 100% correctly," and it calls out that
alternatives like `happy-dom` are "not considered safe" as a DOMPurify host. Running DOMPurify
server-side means jsdom itself joins the trust boundary and must be kept current, not treated as
inert plumbing.

### Bypass cadence

The [DOMPurify GitHub Security Advisories page](https://github.com/cure53/DOMPurify/security/advisories)
(checked 2026-08-31) lists ten published advisories, all disclosed within roughly a three-month
window: GHSA-r47g-fvhr-h676, GHSA-hpcv-96wg-7vj8, GHSA-76mc-f452-cxcm, GHSA-rp9w-3fw7-7cwq,
GHSA-x4vx-rjvf-j5p4, GHSA-gvmj-g25r-r7wr, GHSA-vxr8-fq34-vvx9, GHSA-cmwh-pvxp-8882,
GHSA-c2j3-45gr-mqc4, and GHSA-55q2-fjhq-7xh7 — severities Moderate/Low, clustered heavily around
`IN_PLACE` sanitization mode and mutable-config bugs (`setConfig`/hooks permanently polluting shared
allowlists across calls, a Trusted Types policy surviving `clearConfig()`, a Shadow-Root-inside-
`<template>` bypass). A version pinned even a few months ago is plausibly missing a real fix; this
cadence — not a hypothetical — is the strongest primary-source argument against treating any single
sanitize pass as a one-time, install-and-forget operation.

### sanitize-html (Node)

[`sanitize-html`](https://github.com/apostrophecms/sanitize-html) (now folded into the
[ApostropheCMS monorepo](https://github.com/apostrophecms/apostrophe/blob/main/packages/sanitize-html/README.md)
under the same npm package name) is built on `htmlparser2` and is likewise explicitly allowlist-based:
"you can specify the tags you want to permit, and the permitted attributes for each of those tags."
Neither `script` nor `style` is in its default allowlist, and the docs say why directly: "Allowing
either `script` or `style` leaves you open to XSS attacks. Don't do that unless you have good reason
to trust their origin." Its stated design philosophy is explicitly server-trust-boundary language:
"servers must never trust browsers." Unlike DOMPurify, it needs no DOM implementation (real or
jsdom) — it's a pure parser, which removes jsdom from the trust surface entirely if used as the
backend's sanitizer instead of DOMPurify+jsdom.

Other allowlist-based options worth naming for the same reason DOMPurify and sanitize-html converge
on allowlisting: [`js-xss`](https://github.com/leizongmin/js-xss) (npm `xss`) sanitizes against a
configurable `whiteList` of `{tag: [allowedAttrs]}`, escaping rather than passing through anything
not listed; and, as a cross-language reference for the same principle,
[OWASP's Java HTML Sanitizer](https://github.com/OWASP/java-html-sanitizer) frames its own
`HtmlPolicyBuilder` API as "simple programmatic POSITIVE policy configuration" — the industry
consensus, not an implementation detail specific to any one library, is allowlist over denylist.

### Where sanitization should run, given offline-first local caching

The Client is offline-first and caches message bodies locally (ADR-0002); a compromised or buggy
Sync Backend, or a sanitizer version with an undiscovered bypass, has real consequences for that
design specifically:

- **Sanitize-once-server-side-only, cache the result client-side.** If IndexedDB stores only
  server-sanitized HTML and nothing re-processes it, that cache becomes a durable store of "trusted"
  markup that is never re-validated. The bypass cadence above means a bypass discovered *after* a
  message was ingested leaves every previously-cached body exposed indefinitely unless the backend
  explicitly re-sanitizes and re-pushes its entire historical corpus after every sanitizer security
  release — expensive, easy to miss, and not something a household self-hosted instance will
  reliably do. It is also a single point of failure: nothing stands between a compromised/misconfigured
  backend sanitizer and every Client rendering that message, since the design intent of offline-first
  is specifically to render cached bodies *without* contacting the backend again.
- **Sanitize-only-at-render, client-side.** This solves the retroactive-protection problem — ship a
  new DOMPurify build to the PWA and every cached body benefits on next render — but requires storing
  raw, unsanitized sender HTML in IndexedDB, which is itself a larger at-rest attack surface (any
  future code path that reads and displays a cached body without going through the sanitize call —
  a notification snippet, a search preview, an export feature — is a full bypass), and DOMPurify's own
  README warns against exactly this shape of risk when it cautions that modifying HTML after
  sanitization can "easily void the effects of sanitization" — the corollary is that the *last*
  processing step should be as close to the render sink as possible, which argues against treating an
  intermediate cache as trusted.
- **Both, at each boundary.** This is what DOMPurify's own documentation points toward: it frames
  itself as one deliberate layer (compatible with a Trusted Types policy via `RETURN_TRUSTED_TYPE`,
  and its companion [DOMFortify](https://github.com/cure53/DOMFortify) project exists specifically to
  add a whole-page backstop on top of call-site sanitization), and other write-ups of its threat
  model note that server-side filters are a normal complement, not a redundant one, precisely because
  neither layer alone is reliable against every bug class.

**Recommendation for this project**: sanitize **once server-side at ingest** (Sync Backend, shrinking
and cleaning the payload before it is ever written to the Client's local store — this also protects
any other consumer of that same cached data, like search indexing), and **again client-side
immediately before DOM insertion** at render time (DOMPurify in the browser, no jsdom needed since a
real DOM is available). The two passes cover different bug classes (jsdom-hosted DOM quirks
server-side vs. real-browser-DOM edge cases client-side) rather than pure duplication, the client
pass is cheap (DOMPurify is designed to be fast, and the input is already mostly clean), and it means
a security release lands protection on the *entire* historical local cache the next time each message
is opened — no backend re-processing job required. See §8 for how this composes with the `<100ms`
thread-open bar.

---

## 2. Iframe sandboxing + CSP

### What `sandbox` tokens actually gate

Per the [WHATWG HTML spec's sandboxing section](https://html.spec.whatwg.org/multipage/origin.html#sandboxing),
an `<iframe>` with an **empty** `sandbox` attribute applies the full restriction set: the sandboxed
navigation flag (no navigating other browsing contexts), the sandboxed auxiliary-navigation flag (no
popups), the sandboxed origin flag (the document gets a fresh **unique opaque origin** on every load,
rather than the origin its URL/scheme would otherwise imply), the sandboxed scripts flag (no script
execution), and the sandboxed forms flag (no form submission). [MDN's `<iframe>` reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe)
confirms the same baseline and documents the tokens that individually lift one restriction each:

| Token | Lifts |
|---|---|
| `allow-same-origin` | treats the document as its "real" origin instead of an opaque one — grants access to that origin's cookies/storage |
| `allow-scripts` | re-enables script execution (does **not** by itself re-enable popups) |
| `allow-popups` | allows `window.open()`/`target="_blank"` (otherwise these silently no-op) |
| `allow-forms` | allows form submission (forms still render without it, only submission is blocked) |
| `allow-top-navigation` | allows the framed content to navigate the actual browser tab — never grant this to sender HTML |

**The one combination to never use on sender content**: MDN states it as a direct warning — "it is
strongly discouraged to use both `allow-scripts` and `allow-same-origin`, as that lets the embedded
document remove the `sandbox` attribute — making it no more secure than not using the `sandbox`
attribute at all." For this project, that means the sandboxed message-body iframe must never carry
both tokens together, regardless of which sizing technique (§5) is chosen.

### CSP directives and how they get delivered

[MDN's CSP guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP) documents the
directives that matter here: `default-src 'none'` as the deny-by-default fallback; `img-src` to scope
which image sources are allowed (this is where the image-proxy design in §3 becomes load-bearing —
see the gotcha below); `style-src`/`font-src` to stop remote CSS/font-based exfiltration; `script-src`
with a per-render nonce (MDN's documented pattern, not `'unsafe-inline'`) so nothing except a specific
first-party `<script>` tag executes; `form-action 'none'` to kill sender-authored form
exfiltration/phishing even as defense-in-depth on top of `sandbox` lacking `allow-forms`; and
`object-src 'none'`/`base-uri 'none'` to close plugin-embed and `<base>`-href-rebinding vectors.

Delivering that CSP via `<meta http-equiv="Content-Security-Policy">` inside `srcdoc` content has real
gaps versus an HTTP response header: the [W3C CSP3 spec's `<meta>` section](https://w3c.github.io/webappsec-csp/#meta-element)
states `frame-ancestors`, the CSP `sandbox` directive, and `report-uri`/`report-to` are **not**
supported via `<meta>`, and `Content-Security-Policy-Report-Only` cannot be delivered via `<meta>` at
all; the policy also only applies to content that follows it in `<head>`, and editing the `content`
attribute after parse is a no-op. A dedicated, real HTTP route serving the sanitized document (its own
same-origin URL, not `srcdoc`/`blob:`/`data:`) gets the full directive set, including
`frame-ancestors 'none'` — worth calling out because MDN's own iframe docs warn plainly that
"sandboxing is useless if the attacker can display content outside a sandboxed `<iframe>`," e.g. if a
user opens the frame in a new tab, and recommends serving such content from a separate origin for
exactly this reason.

### `srcdoc` vs. `blob:` vs. `data:`

Per MDN, an **unsandboxed** `srcdoc` document inherits its origin from the *embedding* page — dangerous
for hostile content by default, but `sandbox` (without `allow-same-origin`) overrides this and forces
the fresh opaque origin regardless. A `<meta>` CSP inside `srcdoc` content is real, shipped behavior
(corroborated by a 2012 WHATWG mailing-list thread on exactly this mechanism and by Mozilla Bugzilla
reports that presuppose its enforcement), but a closed [w3c/webappsec-csp issue #700](https://github.com/w3c/webappsec-csp/issues/700)
documents that the *embedding* page's own CSP is additionally enforced against `srcdoc` content
(the two are intersected) — so the app shell's own CSP is a hard ceiling on the `srcdoc` document
regardless of what its own meta CSP permits, and should be at least as strict as what's wanted inside.

Per [MDN's `data:` scheme reference](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/data),
`data:` URIs are always treated as unique opaque origins, and modern browsers additionally block
top-level navigation to `data:` URLs outright as a phishing mitigation — meaning a `data:`-sourced
iframe can't be the target of "open in a new tab." Per [MDN's `blob:` scheme reference](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob),
a blob URL's origin is "the origin of the creator of this URL" — it **inherits** whatever origin
called `URL.createObjectURL()`, unlike `data:`'s automatic opacity, so a blob URL created by the
app's own top-level script is same-origin with the app unless the consuming iframe also carries
`sandbox` without `allow-same-origin` to force the opaque origin regardless. Neither `blob:` nor
`data:` is an HTTP response, so CSP for either must go via `<meta>`, with the same feature gaps noted
above.

### An origin gotcha for the CSP that follows from this

Because the sandboxed message-body document gets a unique **opaque** origin (no `allow-same-origin`),
`img-src 'self'` inside its meta CSP does not mean "the app's real origin" — it means "this one-off
opaque origin," which matches nothing else on the network. Since §3's image-proxy design rewrites
every remote image reference to a path on the app's *real* backend origin, the CSP must name that
origin explicitly (e.g. `img-src https://mail.example.com data: blob:`), not rely on `'self'` — a
detail easy to get subtly wrong and end up either over-permissive (`https:` unscoped, defeating the
proxy entirely by letting the sandboxed document fetch senders' URLs directly) or under-permissive
(images silently fail to load because `'self'` never matches).

---

## 3. Remote image interception/rewriting

### How Gmail and Fastmail document this

Google's own [Google Workspace Admin Help page on the image proxy allowlist](https://knowledge.workspace.google.com/admin/gmail/advanced/set-up-an-image-url-proxy-allowlist)
states directly: "Gmail uses Google's secure proxy servers to serve images that might be included in
these messages. This protects your users and domain against image-based security vulnerabilities" —
confirmed server-side proxying through Google's own infrastructure, not a client-side toggle of
direct fetches, and the same page calls disabling the proxy "not recommended." The
[Gmail Help Center page on turning images on or off](https://support.google.com/mail/answer/145919)
states the rationale in Google's own words: "Gmail checks the images for known harmful software,"
and "Senders can't use image loading to get information about your computer or location. Senders
can't use the image to set or read cookies in your browser" — privacy plus malware scanning, exactly
the two reasons this project cares about a proxy. The same page documents Gmail also running its own
suspicious-sender heuristic that withholds images independent of the user's general setting.

[Fastmail's help article on blocking remote images](https://www.fastmail.help/hc/en-us/articles/1500000278102-Blocking-remote-images)
states the same design even more explicitly, and directly confirms the "proxy even when approved"
point this project needs: "Whenever you choose to load remote images, our servers always load the
images on your behalf, so the image host still won't know your IP address." Fastmail's setting tiers
("Show remote images," "Show remote images from senders in my contacts, otherwise ask," "Always ask")
are conceptually the same shape as this project's Approved/Unscreened/Blocked Sender tiers — the
proxy stays in the path unconditionally; what changes per tier is only whether the proxy is *allowed*
to fetch and return the bytes at all. (Thunderbird also blocks remote content by default per its own
support documentation, but its primary source could not be fetched directly in this research —
[support.mozilla.org's remote-content KB page](https://support.mozilla.org/en-US/kb/remote-content-in-messages)
returned a bot-challenge on every attempt, so its exact mechanism — client-side toggle vs. server-side
proxy — is reported here only as a lower-confidence, search-indexed description, not a verified quote.)

### Why a proxy, not a client-side fetch toggle, even for approved senders

This reasoning follows directly from HTTP, and is corroborated by Fastmail's explicit statement above:
if "unblocking" an image means letting the Client's own browser network stack fetch
`<img src="https://sender.example/t.gif?uid=...">` directly, the sender's server still receives the
viewer's real IP address, User-Agent, TLS fingerprint, and any per-recipient tracking token embedded
in the URL — exactly what blocking-by-default is meant to prevent, and this leak happens *specifically
in the approved-sender case*, the one state where images actually load. Routing the fetch through the
Sync Backend (or a dedicated fetch route) instead means the sender's server only ever sees the proxy's
IP and User-Agent, never the viewer's, in both the blocked state (no fetch at all) and the
approved-sender state (fetch happens, but server-to-server).

### Rewriting and the SSRF risk this introduces

The mechanical rewrite — turning `<img src="http://sender.example/x.png">` into
`<img src="/api/messages/:id/image-proxy?url=<encoded>">`, and rewriting `background-image: url(...)`
in the same pass — is standard engineering practice with no single canonical spec, essentially
universal across major webmail clients. What is spec-worthy is the risk it introduces: a backend
endpoint that fetches whatever URL a client hands it is itself a Server-Side Request Forgery
primitive, since the request now originates from a server that may reach internal services, cloud
metadata endpoints, or loopback-bound admin ports an external sender could never reach directly.
[OWASP's SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
gives concrete, quotable guidance: prefer allowlists over denylists ("Deny-lists are bypass-prone.
Prefer allow-lists"); reject non-`http(s)` schemes outright (`file:`, `data:`, `javascript:`); block
loopback (`127.0.0.0/8`, `::1/128`), the RFC1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`,
`192.168.0.0/16`), and cloud metadata addresses (`169.254.169.254`); and — critically — guard against
DNS rebinding, since validating a hostname once is insufficient when it can later resolve to a
different (internal) IP: resolve all A/AAAA records, validate each against the private-range
deny-list, and pin the resolved IP for the actual outbound connection rather than re-resolving at
fetch time. OWASP additionally recommends network-layer egress restrictions as a second, independent
control on top of application-level validation.

---

## 4. `cid:` inline image resolution

[RFC 2392](https://www.rfc-editor.org/rfc/rfc2392) specifies the `cid:` URL scheme: "the 'cid' scheme
refers to a specific body part of a message; its use is generally limited to references to other body
parts in the same message." Its conversion rule is exact and worth quoting because it is the source
of a common parsing bug: "A 'cid' URL is converted to the corresponding Content-ID message header by
removing the 'cid:' prefix, converting the % encoded character to their equivalent US-ASCII
characters, and enclosing the remaining parts with an angle bracket pair, '<' and '>'." The RFC's own
worked example makes this concrete: `cid:foo4%25foo1@bar.net` corresponds to
`Content-ID: <foo4%25foo1@bar.net>`. **The angle brackets are part of the `Content-ID:` header
syntax, not part of the `cid:` URL string** — an implementation that stores Content-IDs with brackets
in its lookup map but strips brackets when parsing the `cid:` reference (or vice versa) will silently
fail every lookup and render broken-image placeholders for legitimately inline-attached images.

[RFC 2557](https://www.rfc-editor.org/rfc/rfc2557) (MHTML) specifies how a root document (HTML) is
aggregated with the resources it references into one `multipart/related` structure, addressable
either by `Content-Location` or `Content-ID`, and is explicit that the two are not interchangeable:
"When URIs employing a CID (Content-ID) scheme are used to reference other body parts in an MHTML
multipart/related structure, they MUST only be matched against Content-ID header values, and not
against Content-Location header with CID: values." A `cid:` reference must therefore only ever be
resolved against the `Content-ID` map, never against `Content-Location`, even if a message happens to
carry a superficially similar-looking value in both headers.

**Practical resolution at render time**: walk the MIME tree, build a map from Content-ID (brackets
stripped, per RFC 2392) to each part's decoded bytes and declared MIME type; walk the sanitized
HTML/CSS for `cid:`-scheme references, strip the prefix and percent-decode to get the lookup key, and
resolve strictly against that Content-ID map; replace the reference with a `blob:` URL (`new Blob([...],
{type})` + `URL.createObjectURL()` — avoids ~33% base64 bloat, lets the browser's normal image
decode/cache path handle it) or a `data:` URI (simpler lifecycle, no `revokeObjectURL` bookkeeping,
but bloats the HTML string). This substitution should happen on a controlled internal representation
as part of, or immediately before, sanitization — not by string-matching against already-sanitized
HTML — and the sanitizer's `ALLOWED_URI_REGEXP` (or sanitize-html's equivalent scheme allowlist) must
be configured to permit `blob:`/`data:` in image/`url()` contexts, since it should otherwise strip
those exact schemes when they appear anywhere else.

---

## 5. Iframe auto-sizing

### Two variants, and the tradeoff between them

**Same-origin direct read** (`allow-same-origin`, no `allow-scripts`): the parent reads
`iframe.contentDocument.documentElement.scrollHeight` directly. Per a GitHub discussion on the MDN
content repository ([mdn/content#42633](https://github.com/mdn/content/issues/42633)), origin access
for this kind of DOM read is gated purely by `allow-same-origin`, independent of `allow-scripts` — so
this works with **zero script execution inside the frame at all**. It is the smaller attack surface of
the two variants: sender HTML is inert regardless of sanitizer or CSP bugs, because nothing executes.
Its downside is needing to poll or otherwise detect layout changes from the parent side rather than
being pushed an update.

**Cross-origin `postMessage`** (`allow-scripts`, no `allow-same-origin`): a small first-party script
inside the framed document uses [`ResizeObserver`](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver)
on `document.body` and calls `parent.postMessage({height}, '*')` on each callback, per
[MDN's `Window.postMessage` reference](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage),
which documents `postMessage` as explicitly designed to work across opaque origins ("Because `data:`
URLs have opaque origins, in order to send messages to a context with a `data:` URL, you must specify
`"*"`" — the same reasoning applies to a sandboxed opaque-origin iframe). Because the sender's
`event.origin` reads as the literal string `"null"` for an opaque origin, the parent cannot
discriminate senders by origin string; it should instead verify `event.source === iframe.contentWindow`
and validate the message shape (an object of exactly the expected form) before trusting the height
value.

### Is granting `allow-scripts` for a trusted measurement script safe here?

This specific question — a first-party measurement script co-resident with sanitizer-stripped sender
HTML inside one `allow-scripts`-only sandboxed document — is not directly addressed by any WHATWG/MDN
primary source found in this research; the analysis below is this project's own reasoning built from
the confirmed primitives above (opaque-origin isolation, `postMessage` cross-origin behavior, and
CSP nonce mechanics), not a documented recommendation.

The opaque-origin guarantee holds regardless of what executes inside: without `allow-same-origin`,
even if some hostile script slipped past the sanitizer and CSP, it cannot read the real origin's
cookies, localStorage, IndexedDB, or make a credentialed same-origin request to the backend — that
isolation is independent of the `allow-scripts` decision. The residual risk is narrower and specific:
the trusted measurement script and any surviving hostile script would share one JavaScript realm (one
`window`, one `document`), so there's no isolation *between* them the way there is between the iframe
and the parent. A CSP `script-src 'nonce-<per-render>'` — where the nonce is generated per render and
never appears in sanitizer output, since the sanitizer strips all `<script>` tags and `on*` attributes
from sender content — closes this: only the app's own nonced script tag executes, sanitizer failure
alone doesn't imply script execution because CSP is the independent second gate. The parent should
also clamp/sanity-check posted height values (reject non-finite numbers, cap at some generous bound)
against a hostile script spamming bogus values.

**Recommendation**: prefer the `allow-scripts`-only, nonce-gated `postMessage` variant for the event-driven
resize behavior it gives (matters for the `<100ms` interactivity bar — no polling loop competing for
the main thread), on the condition that the CSP nonce is genuinely enforced and unique per render. A
fixed `max-height` with internal scroll is a simpler, lower-risk fallback — it needs no script
execution and no measurement at all, at the UX cost of a nested scrollbar and content clipped into a
fixed pane rather than flowing with the page — worth keeping as the degrade path if the sizing
mechanism ever misbehaves.

---

## 6. Dark mode over sender-authored HTML

### Gmail: no primary documentation of its heuristic found

Google's own developer-facing CSS reference for HTML email,
[developers.google.com/workspace/gmail/design/css](https://developers.google.com/workspace/gmail/design/css),
documents supported selectors, properties, and media features and contains **no mention** of
`prefers-color-scheme`, `color-scheme`, dark mode, or color inversion anywhere on the page. No Google
help-center or developer page describing a dark-mode color-rewrite heuristic for sender HTML, or
confirming/denying support for the standard opt-out mechanisms, was found. What exists instead is
third-party reverse-engineering: an [email-bugs GitHub issue](https://github.com/hteumeuleu/email-bugs/issues/68)
from October 2019 documents early breakage (intentionally dark backgrounds lightened, brand colors in
images distorted by an inversion filter), and independent write-ups describe Gmail's mobile apps as
running a proprietary, undocumented color-rewrite algorithm that, per this third-party reporting,
ignores `prefers-color-scheme` even when senders declare it correctly. **This should be treated in
this project's own design as an undocumented, reverse-engineered behavior, not a vendor-confirmed
contract** — there is no Google primary source to rely on for how Gmail specifically decides to
invert or preserve a given sender's colors.

### Apple Mail: a real primary source, with real limits

Apple's own WebKit engineering blog directly documents this for Mail. [Dark Mode Support in WebKit](https://webkit.org/blog/8840/dark-mode-support-in-webkit/)
(Timothy Hatcher, WebKit team, May 2019) states: "For simple content, an app could transform colors in
the document for dark mode. This is what Mail does in macOS Mojave — it displays simple email
messages with a dark mode interpretation... For this reason Safari and WebKit do not auto-darken web
content — documents will need to opt-in to dark mode." Critically, it documents the opt-out/opt-in
mechanism directly: "The `color-scheme` style property... also allows Mail to know which color scheme
to use for an email message, as it can affect the auto-darkening transformations that get applied to
the message's colors. Declaring `color-scheme: light dark` in a rich email message lets Mail know it
supports its own styling for dark mode. You can also specify `light only`, informing Mail that it
should not transform your light color scheme email message." This is Apple's own engineering
documentation, not a third-party inference — Mail auto-darkens messages that don't opt in, and
respects a sender's `color-scheme` declaration as the signal to do otherwise. What is **not**
documented anywhere publicly found in this research is the exact algorithm behind Mail's
"auto-darkening transformation" for non-opted-in messages — no public WebKit bug discussion of the
internal heuristic specifics was found, and this document says so rather than guessing.

### The standards-based hook, and the fallback heuristic

The two standard, cross-client hooks are [`@media (prefers-color-scheme)`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme)
and [`<meta name="color-scheme">`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/color-scheme),
which let sender CSS respond to (or opt out of) dark mode when the sender chooses to declare it. For
senders who don't declare either, the well-known fallback across the email-development community is
CSS filter inversion applied selectively, not blindly — [Aral Balkan's writeup](https://ar.al/2021/08/24/implementing-dark-mode-in-a-handful-of-lines-of-css-with-css-filters/)
gives the exact, attributable pattern: `filter: invert(100%) hue-rotate(180deg)` on the body, then the
*identical* filter reapplied to `img, video, iframe, svg` — two inversions compose back to the
original for exactly those elements, avoiding the "photo negative" problem of a naive whole-body
invert turning logos and photos into inverted color negatives while everything else (background, text)
stays correctly inverted. This is not an email-specific citation, but the identical mechanism is what
real dark-mode email implementations reuse.

---

## 7. Inline preview of image and PDF attachments

### Images, including SVG

[`URL.createObjectURL()`](https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static)
is the standard mechanism: build a `Blob` from decoded attachment bytes, get a `blob:` URL, use it as
an `<img src>`, and call `URL.revokeObjectURL()` when done to avoid leaking memory. SVG attachments
need one specific check: MDN's [SVG as an image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)
guide states directly, "for security purposes, some browsers place restrictions on SVG content when
it's being used as an image. Specifically... JavaScript is disabled," and separately confirms this
does **not** apply "when SVG content is viewed directly, or when it's embedded as a document via the
`<iframe>`, `<object>`, or `<embed>` elements" — i.e., previewing an SVG attachment via `<img
src="blob:...">` is script-inert in a way that `<object>`/`<iframe>`/`<embed>` embedding of the same
file is not. MDN's own phrasing ("some browsers") is a hedge rather than an absolute cross-browser
guarantee, so this is worth an empirical check against the project's actual target rendering engines
before relying on it as the sole SVG defense, but it is the correct default technique either way:
always render attached SVGs via `<img>`, never via `<object>`/`<iframe>`/`<embed>`.

### PDFs: pdf.js vs. the browser's native viewer

[pdf.js](https://mozilla.github.io/pdf.js/) is Mozilla's own project, and its
[README](https://github.com/mozilla/pdf.js) states plainly it "is built into version 19+ of Firefox"
— it is Firefox's actual native PDF viewer, not a demo, and operates as a pure client-side HTML5/JS
renderer with no server round-trip. Its security story has one concrete, documented incident: [GHSA-wgrm-67xf-hhpq / CVE-2024-4367](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq),
"Arbitrary JavaScript execution upon opening a malicious PDF," affecting `pdfjs-dist` ≤ 4.1.392 when
configured with `isEvalSupported: true` (the then-default) — the advisory states unrestricted
attacker-controlled JavaScript would execute "in the context of the hosting domain." The fix in
4.2.67+ removed the underlying `eval()`-based code path entirely rather than only flipping the
default, and `isEvalSupported` no longer exists in the current pdf.js source at all. What does exist
today, confirmed directly against the pdf.js source (`web/app_options.js`), is `enableScripting`, a
documented viewer option (default `true`, except in the Chrome-extension build variant) that gates
whether PDF-embedded JavaScript (Acrobat-style form scripts) executes at all — an app embedding
pdf.js as a component has first-party, explicit control here.

No primary Mozilla or Chromium source was found making a direct comparative security claim between an
app-embedded pdf.js instance and the browser's own native PDF viewer (PDFium in Chromium; pdf.js
itself in Firefox, without the app's ability to configure `enableScripting`/CSP around it) — this is
architectural reasoning, not a documented vendor position: embedding a pinned pdf.js build inside the
app's own already-sandboxed context, with `enableScripting: false` set explicitly, keeps a malicious
PDF inside the same CSP/sandbox regime as the rest of message rendering, rather than handing it to
browser-privileged native code the app has no configuration surface over.

---

## Recommended pipeline

Sized to "speed and UX beat dev-experience" and checked against the `< 100ms` thread-open /
250,000-message corpus bar. The bar constrains *when* sanitization happens, not *whether* it
happens twice — sanitizing an already-mostly-clean, single message's HTML string is O(one message),
not O(corpus), so it never touches the list/search/index performance the corpus bar is actually
stressing.

**Sync Backend (ingest time, off the read hot path, once per message):**

1. Parse the MIME tree; build the `Content-ID` → bytes/MIME-type map (brackets stripped per
   [RFC 2392](https://www.rfc-editor.org/rfc/rfc2392), matched only against `Content-ID`, never
   `Content-Location`, per [RFC 2557](https://www.rfc-editor.org/rfc/rfc2557)); store inline-image
   attachment bytes alongside the message.
2. Run DOMPurify+jsdom (pinned, version-tracked against its [advisories page](https://github.com/cure53/DOMPurify/security/advisories))
   or `sanitize-html`, with a narrow email-appropriate `ALLOWED_TAGS`/`ALLOWED_ATTR` — structural and
   inline-formatting tags, `img`/tables/links, no `script`/`iframe`/`object`/`embed`/`form` — and a
   tightened `ALLOWED_URI_REGEXP` covering exactly `https:`, `mailto:`, `tel:`, and `cid:`.
3. Rewrite every remaining remote `<img src>` and CSS `background-image`/`url()` reference to
   `/api/messages/:messageId/image-proxy?src=<encoded>`, HMAC-signed over message/account/URL so a
   cached, previously-sanitized body can't be tampered into pointing the proxy somewhere new. The
   proxy itself checks the Gatekeeper verdict (App Feature, per [ADR-0006](../adr/0006-app-feature-state-lives-in-sync-backend.md))
   for that sender on every request — Approved fetches and streams with a far-future
   `Cache-Control` keyed by URL hash, anything else 403s or returns a placeholder — applying OWASP's
   SSRF guidance: allowlist `http`/`https` only, resolve and validate the IP against loopback/private/
   link-local/metadata ranges at actual connection time (not just at parse time, to close the DNS
   rebinding gap), never trust a redirect target without re-validating it.
4. Store the resulting sanitized HTML (small, `cid:` references left as-is, remote images already
   proxy-rewritten) as the cached message body.

**Client (React/Vite PWA, offline-first, render time):**

1. Read the pre-sanitized HTML string from local storage — no network wait, per the acceptance bar.
2. Resolve remaining `cid:` references against locally-cached attachment bytes into `blob:` URLs via
   `URL.createObjectURL()`.
3. Run DOMPurify once more, in the real browser DOM (no jsdom needed), as the final gate immediately
   before injection — this is what makes a future DOMPurify security release protect the entire
   historical local cache without any backend reprocessing job.
4. Inject via `srcdoc` on an iframe with **`sandbox="allow-scripts"`** — no `allow-same-origin`,
   no `allow-forms`, no `allow-popups`, no `allow-top-navigation` — and a `<meta
   http-equiv="Content-Security-Policy">` reading approximately:
   `default-src 'none'; img-src https://<backend-origin> data: blob:; style-src 'unsafe-inline';
   font-src data:; script-src 'nonce-<per-render>'; form-action 'none'; base-uri 'none'; object-src
   'none'; frame-src 'none'`. Note `img-src` names the backend's real origin explicitly rather than
   `'self'` — the sandboxed document's own origin is opaque (no `allow-same-origin`), so `'self'`
   inside it matches nothing and would silently break the image proxy.
5. Size the iframe via the nonce'd first-party script permitted by that same CSP: `ResizeObserver` on
   `document.body` inside the frame, `postMessage`'d to the parent; the parent verifies
   `event.source === iframe.contentWindow`, validates the message shape, clamps/debounces the height,
   and paints with a skeleton `min-height` immediately so the `<100ms` open never blocks on the
   resize round-trip.
6. Dark mode: if the sanitized HTML carries a sender `color-scheme` declaration (`light dark` or
   `light only`, via CSS or `<meta name="color-scheme">`), respect it, matching Apple Mail's
   documented behavior. Otherwise, when the User's own Preferences theme (per
   [poc-scope.md](../poc-scope.md)) resolves to dark, apply the double-invert technique — `filter:
   invert(100%) hue-rotate(180deg)` on the sanitized body wrapper, reapplied to `img, video, svg,
   picture` to cancel the invert back to normal for media specifically. Never invert when the User has
   chosen light theme regardless of OS preference.
7. Attachment preview: images via `blob:` + `<img>` (SVGs included, always via `<img>`, never
   `<object>`/`<iframe>`/`<embed>`); PDFs via an app-bundled pdf.js instance (pinned ≥ 4.2.67, past
   [CVE-2024-4367](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq)) with
   `enableScripting: false` set explicitly, rendered inside the same sandboxed regime as the message
   body rather than delegated to the browser's native PDF viewer.

This keeps the `<100ms` thread-open path entirely local — one already-fast local read, one
already-mostly-clean re-sanitize, one `srcdoc` write — with remote-image fetching and PDF rendering
happening asynchronously after first paint, and holds under the 250,000-message corpus because none
of this pipeline scales with corpus size: it is per-message work triggered once, at the moment a
single thread is opened.
