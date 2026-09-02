# Mail Account setup & provider seam

Research for [issue #21 "Mail Account setup & provider seam"](https://github.com/vicvancooten/mail/issues/21)
(child of [#1, the wayfinder map](https://github.com/vicvancooten/mail/issues/1)).

Question: the PoC ships autodiscover from the email domain with manual fallback, and a provider seam
where `password` and `oauth` are peers ([ADR-0003](../adr/0003-instance-held-credential-key.md)) so
Gmail is additive rather than a refactor ([#2, PoC scope cut](../poc-scope.md)). What does that
actually take: the autodiscover mechanisms and their real-world coverage, what privateemail (the
PoC's only provider) actually publishes, and what the OAuth path will need from the seam later.

This document does not design OAuth itself — that is [explicitly deferred post-PoC](../poc-scope.md#post-poc)
— it only establishes what shape the seam needs to leave room for.

---

## 1. Autodiscover mechanism survey

Three unrelated, independently-invented mechanisms exist for "give a client an email address and it
finds the server settings." None subsumes the others, none is universally deployed, and each was
built by a different vendor for a different mail stack.

### 1.1 RFC 6186 — DNS SRV records

**Primary source**: [RFC 6186, "Use of SRV Records for Locating Email Submission/Access
Services"](https://www.rfc-editor.org/rfc/rfc6186) (Daboo, Apple Inc., March 2011, Standards Track).

**Mechanism**: the client splits the user's email address into local-part and domain, then queries
DNS SRV records under that domain for the service it wants:

| SRV label | Meaning | Example |
|---|---|---|
| `_submission._tcp` | MSA per [RFC 4409](https://www.rfc-editor.org/rfc/rfc4409), TLS optional (STARTTLS) or implicit | `_submission._tcp SRV 0 1 587 mail.example.com.` |
| `_imap._tcp` | IMAP, `LOGINDISABLED`/`STARTTLS` may apply | `_imap._tcp SRV 0 1 143 imap.example.com.` |
| `_imaps._tcp` | IMAP with implicit TLS | `_imaps._tcp SRV 0 1 993 imap.example.com.` |
| `_pop3._tcp` / `_pop3s._tcp` | POP3, optional/implicit TLS | — |

(§3, quoted directly from the RFC text.)

Per §3.4/§4: when both IMAP and POP3 are offered, the client "SHOULD retrieve records for both
services and then use the service with the lowest priority value" (RFC 2782 priority/weight
selection). A target of `.` means "this service is deliberately absent here" and must not be
treated as a lookup failure the same way NXDOMAIN is. §4 is explicit about the failure path: **"If
an SRV record is not found, the MUA will need to prompt the user to enter the FQDN and port
information directly, or use some other heuristic"** — RFC 6186 itself specifies no heuristic
fallback, only "prompt or something else."

§6 (Security Considerations) flags the DNS-spoofing risk directly: a malicious DNS answer can steer
a client to an attacker's server, so absent DNSSEC, clients "SHOULD check that the target FQDN
returned in the SRV record matches the original service domain that was queried" and confirm with
the user otherwise; certificate verification must follow [RFC 6125](https://www.rfc-editor.org/rfc/rfc6125)
§6 using the SRV record as the reference identity.

**Real-world coverage**: RFC 6186 is a clean, minimal, IETF-standard mechanism — and the least
adopted of the three surveyed here. It requires the *domain owner* (not the mailbox provider) to
publish SRV records, which almost no consumer domain operator does unless their mail host's own
setup wizard adds them automatically. Namecheap Private Email is a useful data point precisely
because it is a mainstream host with millions of hosted domains and its own standard DNS setup
guide (§3 below): **that guide never asks customers to add `_imap._tcp` / `_imaps._tcp` /
`_submission._tcp` records.** The only SRV record it recommends is Microsoft's `_autodiscover._tcp`
(a different, unrelated mechanism — §1.3). RFC 6186 SRV records do exist on `privateemail.com`'s own
domain (verified directly, §3.1) but that is the provider's own zone, not something propagated to
customer domains. Thunderbird's own historical documentation corroborates the low-adoption
read: DNS SRV/TXT records are listed in Mozilla's autoconfiguration wiki as a lookup method that was
**"not yet implemented"** even by Thunderbird itself at the time of writing (see §1.2) — the leading
IMAP-generic MUA didn't consider it worth building.

### 1.2 Mozilla ISPDB / Thunderbird autoconfig

**Primary sources**: [Mozilla wiki, "Thunderbird:Autoconfiguration"](https://wiki.mozilla.org/Thunderbird:Autoconfiguration);
[Mozilla wiki, "Thunderbird:Autoconfiguration:ConfigFileFormat"](https://wiki.mozilla.org/Thunderbird:Autoconfiguration:ConfigFileFormat);
[thunderbird/autoconfig on GitHub](https://github.com/thunderbird/autoconfig) (the ISPDB source itself).

**Mechanism** — an ordered lookup, each step tried only if the previous returned nothing usable:

1. **`autoconfig.<domain>`** — `http://autoconfig.<domain>/mail/config-v1.1.xml?emailaddress=<address>`.
   This is the "provider publishes it themselves" path: the *domain owner* (or their mail host, via a
   CNAME) serves an XML file describing IMAP/SMTP settings for that exact domain.
2. **`.well-known/autoconfig`** on the bare domain — `http://<domain>/.well-known/autoconfig/mail/config-v1.1.xml`,
   a fallback for domains that can't add the `autoconfig` subdomain. Note this is a Mozilla-specific
   convention, not an IANA-registered `.well-known` URI (§1.4).
3. **Mozilla's ISPDB** — a lookup against `https://autoconfig.thunderbird.net/v1.1/<domain>` (formerly
   `live.mozillamessaging.com`), a centralized, community-submitted database of config files for
   major providers. Mozilla's own wiki text claims "90+% hit rate" for **major ISPs and email
   providers** — this is a claim about coverage of well-known providers, not of the long tail of
   custom/shared-hosting domains.
4. **Heuristic guessing** — probing conventional hostnames (`imap.<domain>`, `mail.<domain>`,
   `smtp.<domain>`, etc.) across standard ports, checking for TLS and capability responses.
5. **Manual configuration** — the terminal fallback when all of the above fail.

The config file itself (`config-v1.1.xml`) is a plain, client-agnostic XML schema: `incomingServer`/
`outgoingServer` blocks carrying `hostname`, `port`, `socketType` (`plain` | `SSL` | `STARTTLS`), and
an `authentication` element whose enumerated values already include `password-cleartext`,
`password-encrypted`, `NTLM`, `GSSAPI`, `OAuth2`, and `none` — i.e., the Thunderbird config format
already treats password and OAuth2 as peer values of the same field, which is corroborating,
independent precedent for the `password`/`oauth` seam this ticket is about. Multiple
`incomingServer`/`outgoingServer` entries are allowed "in order of priority," letting a provider
list IMAP before POP3, for instance.

**Real-world coverage**: strong for named consumer/business providers Mozilla has bothered to onboard
(Gmail, Outlook.com, Yahoo, Fastmail, GMX, etc. — hundreds of entries in the [ISPDB config
repo](https://github.com/thunderbird/autoconfig)); essentially nil for `privateemail.com` and for
individual customer domains hosted on it — verified directly: `https://autoconfig.thunderbird.net/v1.1/privateemail.com`
and `.../namecheap.com` both return **HTTP 404** (checked live, §3.1). ISPDB entries are keyed by
domain and are either submitted by the provider or crowd-contributed per-domain; a shared-hosting
mail provider whose customers each own a different domain cannot realistically get every customer
domain into the ISPDB, so step 3 is structurally unavailable for this PoC's provider shape.
Steps 1–2, by contrast, **are** available to privateemail customers, because Namecheap's own setup
docs tell customers to point `autoconfig.<their-domain>` at `privateemail.com` (§3.2) — this is the
step that actually carries weight for this PoC.

### 1.3 Microsoft Autodiscover (POX / EWS)

**Primary sources**: [Microsoft Learn, "Autodiscover service in Exchange
Server"](https://learn.microsoft.com/en-us/exchange/architecture/client-access/autodiscover);
[Microsoft Learn, "Autodiscover for Exchange" (client-developer)](https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/autodiscover-for-exchange);
[Microsoft Learn, "How to control Outlook AutoDiscover by using Group Policy"](https://learn.microsoft.com/en-us/microsoft-365-apps/outlook/profiles-and-accounts/control-autodiscover-via-group-policy).

**Mechanism**: an ordered probe distinct from, and older than, RFC 6186 — designed for Exchange/
Office 365, not generic IMAP:

1. **Active Directory Service Connection Point (SCP) lookup** — domain-joined clients only; irrelevant
   off a Windows domain.
2. **`https://<domain>/autodiscover/autodiscover.xml`** — bare-domain HTTPS POX endpoint.
3. **`https://autodiscover.<domain>/autodiscover/autodiscover.xml`** — the `autodiscover` subdomain
   HTTPS endpoint (the one Namecheap's own KB tells customers to CNAME to `privateemail.com`, §3.2).
4. **Unauthenticated HTTP GET + redirect** — a plain `http://autodiscover.<domain>/autodiscover/autodiscover.xml`
   GET; a `302` redirect is followed to whatever `Location` the server names (this is also how
   Microsoft 365 itself points consumer/business clients at its own multi-tenant endpoint, e.g.
   `autodiscover-s.outlook.com` — and it is why Outlook shows a "do you trust this redirect?" prompt
   the first time, a UX quirk that is [explicitly documented and has its own suppression
   setting](https://learn.microsoft.com/en-us/troubleshoot/outlook/connectivity/suppress-autodiscover-redirect-warning-mac)).
5. **DNS SRV fallback** — a query for `_autodiscover._tcp.<domain>`, distinct from any RFC 6186 label;
   Microsoft's own docs give the canonical shape as priority 0, weight 0, port 443, target the
   Autodiscover host (exactly the record Namecheap tells customers to add, §3.2).

There is **no IANA-registered or widely-adopted `.well-known/autodiscover` path** — Microsoft's
mechanism predates and is unrelated to the IETF `.well-known` URI convention (RFC 8615; confirmed
directly against [IANA's Well-Known URI registry](https://www.iana.org/assignments/well-known-uris/well-known-uris.xhtml),
§1.4). "The `.well-known` variant" for Microsoft, in practice, is really the `autodiscover.<domain>`
subdomain step above, not a `.well-known/`-prefixed path.

**Relevance to this PoC**: low as a *discovery mechanism* to build against, for exactly the reason
the ticket anticipates — Autodiscover targets Exchange/EWS-shaped responses (mailbox GUID, EWS URL,
OOF settings, offline address book) that privateemail and other plain-IMAP hosts have no reason to
implement in full. What *is* relevant: privateemail's own setup docs recommend the Autodiscover
CNAME/SRV pair anyway (§3.2), almost certainly so that Outlook desktop — which tries Autodiscover
before anything else and has no generic IMAP-only autoconfig fallback of its own — doesn't fall all
the way through to a manual-entry dead end for privateemail customers who happen to use Outlook.
This PoC's own client is not Outlook, so Autodiscover is not worth implementing as a discovery
mechanism for the Sync Backend; it is listed here for completeness and because privateemail
publishing it is itself informative about what discovery surface actually exists for the PoC's
provider (§3).

### 1.4 `.well-known` variants, generally

Checked directly against the [IANA Well-Known URI registry](https://www.iana.org/assignments/well-known-uris/well-known-uris.xhtml)
(the authoritative registry defined by [RFC 8615](https://www.rfc-editor.org/rfc/rfc8615)): **neither
`autoconfig` nor `autodiscover` nor any generic `mail` path is registered.** The only mail-adjacent
registrations are `caldav` and `carddav` (both [RFC 6764](https://www.rfc-editor.org/rfc/rfc6764),
which is calendar/contacts, not IMAP/SMTP). This means:

- Mozilla's `.well-known/autoconfig/mail/config-v1.1.xml` (§1.2 step 2) is a **de facto convention
  Mozilla defined for its own client**, not an IETF-sanctioned `.well-known` URI — it works only
  because Thunderbird (and clients that copy its behavior, e.g. some KMail/Evolution builds) look
  for it, not because it is a registered standard other software is obligated to support.
- There is no `.well-known` equivalent for RFC 6186 SRV records or for Microsoft Autodiscover —
  both of those mechanisms operate entirely through DNS or subdomain conventions instead.

---

## 2. Failure modes worth falling back from

Ordered roughly by where each mechanism actually breaks in practice, based on the mechanics above:

| Failure | What it looks like | Where it's common |
|---|---|---|
| **No SRV records at all** | NXDOMAIN / empty answer set on every `_imap(s)._tcp` / `_submission._tcp` query | The overwhelming majority of domains — shared/reseller hosting almost never publishes RFC 6186 records (confirmed for privateemail, §3.1) |
| **SRV record present but explicitly disabled** | Target is `.` per RFC 6186 §3.4 | Rare, but a client that doesn't special-case `.` will otherwise try to connect to the literal hostname `.` and fail confusingly |
| **`autoconfig.<domain>` absent** | DNS resolution failure or a generic web server's default page/404, not XML | Any domain whose owner didn't add the optional CNAME — this includes privateemail customers who skipped the "optional" DNS records in Namecheap's setup guide |
| **`.well-known/autoconfig` absent** | HTTP 404 (privateemail.com's own domain returns exactly this — verified directly, `HTTP 301` redirecting to the marketing site, not real XML content) | Same population as above; this is a secondary fallback for the same failure |
| **ISPDB has no entry for the domain** | Clean 404 from `autoconfig.thunderbird.net/v1.1/<domain>` (verified directly for both `privateemail.com` and `namecheap.com`) | Any domain not itself a major named provider — structurally guaranteed for privateemail's customer-domain model, since ISPDB is keyed per domain, not per shared-hosting brand |
| **TLS/port probing (heuristic guessing) gives a false positive or times out** | A guessed hostname (`mail.<domain>`, `imap.<domain>`) resolves to *something* (a web server, a parked-domain page, a different mail host entirely) that isn't the real IMAP/SMTP endpoint, or the probe simply times out across several hostname/port combinations | Any domain with unrelated infrastructure at conventional hostnames; also the slowest fallback step, since it means several sequential/parallel connection attempts before giving up |
| **DNS spoofing / on-path tampering** | Any of the above returns a plausible-looking but attacker-controlled answer | RFC 6186 §6 calls this out explicitly for SRV; the same class of risk applies to any DNS-based step (SRV, CNAME-based autoconfig/autodiscover subdomains) absent DNSSEC — cert verification against the queried domain is the mitigation, not blind trust in the DNS answer |
| **Autodiscover cross-domain redirect prompt** | A `302` to a different domain than the one queried, which desktop Outlook surfaces to the user as a trust prompt | Explicitly documented as expected Microsoft 365 behavior; not applicable to this PoC's own client, but is the reason a home-grown discovery client should decide *itself* what redirect targets it trusts rather than blindly following them, if it ever follows autoconfig/autodiscover redirects at all |

The unifying shape: **every mechanism here degrades to "no answer," not "wrong but confident
answer," when it isn't configured** — except DNS spoofing and heuristic false positives, both of
which are exactly why RFC 6186 mandates certificate-identity verification against the queried
domain rather than blind trust in whatever a lookup returns. That gives a clean rule for where
autodiscover should give way to manual entry: **the moment a mechanism produces no structured
answer at all (NXDOMAIN, 404, no ISPDB row), move to the next mechanism; the moment TLS/certificate
verification of a *found* answer fails, stop and surface it as a discovery failure requiring manual
confirmation, rather than silently trying yet another guess.**

---

## 3. What privateemail.com actually publishes

privateemail.com is [Namecheap Private
Email](https://www.namecheap.com/support/knowledgebase/article.aspx/1179/2175/general-private-email-configuration-for-mail-clients-and-mobile-devices/),
the PoC's only provider ([poc-scope.md](../poc-scope.md)). This section is grounded in Namecheap's
own DNS setup documentation plus DNS records queried directly during this research (via
DNS-over-HTTPS against Cloudflare's `1.1.1.1` resolver, since raw UDP port 53 was not reachable from
the research sandbox — HTTPS was).

### 3.1 Direct DNS/HTTP findings against `privateemail.com` itself

| Query | Result |
|---|---|
| `MX privateemail.com` | `10 mx1.privateemail.com.`, `10 mx2.privateemail.com.` |
| `SRV _imaps._tcp.privateemail.com` | `1 1 993 imap.privateemail.com.` — **RFC 6186 records do exist on privateemail.com's own zone** |
| `SRV _submission._tcp.privateemail.com` | `0 1 587 mail.privateemail.com.` |
| `A mail.privateemail.com` | `198.54.122.135` |
| `A autoconfig.privateemail.com` | `198.54.117.245` (CNAME query returned no data — it's an A record, not itself a CNAME) |
| `A autodiscover.privateemail.com` | `198.54.117.245` |
| `GET http://autoconfig.privateemail.com/mail/config-v1.1.xml?...` | `302` to `https://privateemail.com` (marketing site, not XML) |
| `GET https://autodiscover.privateemail.com/autodiscover/autodiscover.xml` | `302` to `https://privateemail.com` |
| `GET http://privateemail.com/.well-known/autoconfig/mail/config-v1.1.xml` | `301` to the HTTPS version of the same path, `server: BigIP` |
| `GET https://autoconfig.thunderbird.net/v1.1/privateemail.com` | **404** — no ISPDB entry |
| `GET https://autoconfig.thunderbird.net/v1.1/namecheap.com` | **404** — no ISPDB entry |

**Caveat on the redirect results**: `privateemail.com` itself is Namecheap's marketing/product
domain, not a customer mailbox domain, so its `autoconfig`/`autodiscover` subdomains redirecting to
the marketing site rather than serving real XML is expected and doesn't demonstrate what a *real*
customer domain gets back. Live XML content could not be verified in this pass because no
privateemail-hosted customer domain with an active mailbox was available to query against — the
user's own domain (`a-insights.eu`) turned out to be hosted on Microsoft 365 (`MX 10
ainsights-eu0c.mail.protection.outlook.com.`, confirmed directly), not privateemail. **This is a gap
worth closing before the setup flow ships**: point the discovery flow at a real privateemail test
domain during implementation and confirm the actual `config-v1.1.xml` content it returns.

### 3.2 What Namecheap's own setup docs tell customers to publish

Per Namecheap's Private Email DNS knowledgebase articles ([records for domains with third-party
DNS](https://www.namecheap.com/support/knowledgebase/article.aspx/1340/2176/namecheap-private-email-records-for-domains-with-thirdparty-dns/),
[Cloudflare setup guide](https://www.namecheap.com/support/knowledgebase/article.aspx/9967/2176/how-to-set-up-dns-records-for-namecheap-email-service-with-cloudflare-cpanel-and-private-email/)),
customers are told to add:

**Required for mail to work at all:**
- `MX @ 10 mx1.privateemail.com` and `MX @ 10 mx2.privateemail.com`
- `TXT @ "v=spf1 include:spf.privateemail.com ~all"` (SPF)
- `TXT default._domainkey <generated>` (DKIM — generated only after a mailbox exists)
- `TXT _dmarc "v=DMARC1; p=..."` (DMARC)

**Explicitly optional, "for automatic email account setup by email clients":**
- `CNAME mail → privateemail.com` (webmail redirect, unrelated to autodiscovery)
- `CNAME autoconfig → privateemail.com` — this is what makes Mozilla-style autoconfig (§1.2 step 1)
  reachable for a privateemail customer domain
- `CNAME autodiscover → privateemail.com` — this is what makes Microsoft-style Autodiscover (§1.3
  steps 2–3) reachable
- `SRV _autodiscover._tcp <domain> 0 0 443 privateemail.com` — the Microsoft Autodiscover SRV
  fallback (§1.3 step 5), **not** an RFC 6186 record

The load-bearing finding for this PoC: **privateemail supports Mozilla-style autoconfig and
Microsoft-style Autodiscover for customer domains, entirely opt-in via CNAME/SRV the customer must
add themselves — and supports neither RFC 6186 SRV records for customer domains (only on
privateemail.com's own zone) nor an ISPDB entry (structurally impossible, per-domain database).** A
privateemail customer who skipped the optional records — which is easy to do, since Namecheap's own
required-records guide lists them after the mail-critical ones and calls them out as optional — gets
**no working autodiscovery at all** and lands on manual entry regardless of mechanism.

---

## 4. Recommended setup flow

Given the coverage picture above, the ordering that gives the PoC the best real hit rate for the
least implementation cost:

1. **`autoconfig.<domain>/mail/config-v1.1.xml?emailaddress=<address>`** (plain HTTP first, per
   Mozilla's own convention, then HTTPS if available) — cheapest to implement (one XML schema to
   parse, reused for step 2 and 3), and the one privateemail customers can actually satisfy today by
   following Namecheap's own setup guide.
2. **`https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml`** — same parser, covers domain
   owners who couldn't add the `autoconfig` subdomain specifically.
3. **RFC 6186 SRV lookup** (`_imaps._tcp`, `_submission._tcp`, falling back to `_imap._tcp`/
   `_pop3s._tcp`/`_pop3._tcp` if the TLS-first variants are absent) — cheap, standards-based, worth
   trying even though this research found near-zero real-world publication for it, specifically
   *because* it's nearly free to implement (a DNS query, no HTTP round trip, no XML parsing) and
   costs nothing when it comes back empty. Respect the `.` "explicitly absent" convention (§1.1) and
   the domain-match/cert-verification guidance in RFC 6186 §6.
4. **Mozilla ISPDB lookup** (`https://autoconfig.thunderbird.net/v1.1/<domain>`) — worth keeping for
   the case where Vic (or a future Member) adds a Gmail/Outlook/Fastmail-class account post-PoC;
   contributes nothing for privateemail specifically (§3.1) but is nearly free once the same XML
   parser from steps 1–2 exists, since ISPDB serves the identical schema.
5. **Manual entry** — host/port/TLS for IMAP and SMTP, exactly as scoped in
   [poc-scope.md](../poc-scope.md#sync--accounts). Given §3's finding that privateemail's own
   defaults (without the optional DNS records) leave *no* autodiscovery path reachable, manual entry
   is not a rare edge case for this PoC's actual provider — **it should be a first-class,
   well-designed step, not an apologetic dead end**, since it is realistically the common path for
   privateemail users who never touched the optional DNS records. Pre-filling manual entry with
   privateemail's own documented, stable defaults (`mail.privateemail.com`, port 993/IMAP TLS, port
   587/SMTP STARTTLS or 465 implicit TLS — per [Namecheap's client-setup
   docs](https://www.namecheap.com/support/knowledgebase/article.aspx/1179/2175/general-private-email-configuration-for-mail-clients-and-mobile-devices/))
   when the domain's MX records resolve to `mx1/mx2.privateemail.com` is a reasonable, low-risk
   shortcut worth taking even though it's provider-specific — it degrades gracefully to blank manual
   entry for any other MX.

**Deliberately not implemented for the PoC**: Microsoft Autodiscover (§1.3) and heuristic
hostname/port guessing (§1.2 step 4). Autodiscover targets Exchange/EWS semantics this client
doesn't need and privateemail's own EWS-shaped response (if any) is unverified (§3.1's gap);
heuristic guessing is the least reliable, slowest, and least standards-grounded of the mechanisms
surveyed, and manual entry pre-filled with privateemail's known-good defaults (above) covers the
same ground more predictably for this PoC's single-provider scope. Both are reasonable to reconsider
once Gmail/Outlook OAuth (§5) makes "generic third-party IMAP host" a less complete story of who's
adding accounts.

**Per-attempt timeout**: each network step above should have a short, fixed timeout (a few seconds)
and move on rather than hang — nothing in any of the source specs mandates a value, so this is an
implementation choice, not a standards requirement.

---

## 5. What the OAuth path will need from the seam

Out of scope to design here (per [poc-scope.md](../poc-scope.md#post-poc), OAuth is explicitly
deferred), but the seam has to leave room for what these primary sources show OAuth actually
requires, so the PoC's password-only cut doesn't foreclose it.

### 5.1 Gmail

- **App registration is unavoidable and per-project, not per-user**: a Google Cloud project, an
  [OAuth consent screen](https://developers.google.com/identity/protocols/oauth2), and an OAuth
  client (Desktop/Web app type, not a Service Account — service accounts are for Workspace
  domain-wide delegation, which doesn't apply to a self-hoster's personal Gmail). For a project this
  is self-hosted and installed on many independent instances, this raises a real operational
  question the seam config needs to accommodate later: **one shared client ID baked into the
  project (like Thunderbird ships), or a per-instance client ID the self-hoster registers
  themselves** (like many self-hosted integrations do) — either way, the credential *shape* is
  "client id/secret at the instance level," not "per Mail Account," which the seam's config surface
  should leave room for.
- **Scope**: full IMAP/SMTP access requires the *restricted* scope `https://mail.google.com/` (per
  [Gmail's XOAUTH2 documentation](https://developers.google.com/gmail/imap/xoauth2-protocol)) — this
  is Google's broadest, most sensitive scope tier, not an oversight to narrow later.
- **Verification is the real cost, not the OAuth flow itself**: an app requesting a restricted scope
  and left in "Testing" publishing status is capped at 100 test users for the *lifetime of the
  project* (cannot be reset) and — per direct primary-source confirmation from Google's own OAuth
  overview and corroborating community documentation — **refresh tokens issued while in Testing
  status expire after 7 days**, which would silently break sync for any non-test user. Moving to
  "In Production" for a restricted scope requires a **CASA Tier 2 third-party security audit**, per
  [Google's restricted-scope verification
  requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) —
  a real, recurring cost (audits typically need renewal), not a one-time checkbox.
- **XOAUTH2 wire format**: `base64("user=" + email + "\x01auth=Bearer " + accessToken + "\x01\x01")`,
  sent as `AUTHENTICATE XOAUTH2 <token>` over IMAP — mechanically identical in shape to Microsoft's
  (§5.2), which is a useful simplification: the seam's `oauth` variant can share one XOAUTH2 encoder
  across providers, varying only the token-acquisition side.
- **Refresh token lifecycle quirks the seam's storage needs to survive**: Google caps refresh tokens
  at **100 per Google Account per OAuth client ID**, silently invalidating the oldest on overflow;
  refresh tokens also expire after roughly six months of inactivity, and Gmail-scoped tokens are
  invalidated by the user changing their Google password — all per [Google's OAuth 2.0
  documentation](https://developers.google.com/identity/protocols/oauth2). None of these are errors
  the current `password`-only flow has to think about; the credential model needs a path back to
  "needs reauth" (already the Mail Account state for rejected passwords, per
  [CONTEXT.md](../../CONTEXT.md)) that an OAuth variant can land on for exactly these cases,
  not just for a bad password.

### 5.2 Outlook / Microsoft 365 IMAP

- **Basic auth is not a fallback option here — it's already largely gone.** Per [Microsoft's own
  deprecation notice](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online),
  Basic authentication for IMAP, POP, EAS, EWS, and RPS in Exchange Online was disabled starting
  October 1, 2022. SMTP AUTH basic auth is on a slower, still-moving timeline — per Microsoft's
  [updated SMTP AUTH deprecation
  announcement](https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835)
  it stays available for existing tenants through the end of 2026, is off by default (admin can
  re-enable) after that, and unavailable by default for new tenants created after December 2026,
  with a final removal date to be announced in H2 2027. Practically: **for Outlook/M365, `oauth`
  isn't an enhancement over `password` the way it might be for Gmail's app-password stopgap
  (below) — it's the only mode that reliably works**, and this gap is closing further every year the
  PoC doesn't add it. New/newer Outlook.com consumer mailboxes are already showing up with SMTP AUTH
  disabled entirely and no user-facing toggle to re-enable it (per Microsoft's own troubleshooting
  docs), so an [app password](https://ladedu.com/how-to-create-an-app-password-for-outlook-com-pop-imap/)
  is the only password-shaped credential Outlook.com will accept at all in that case.
- **App registration**: an app registered in [Microsoft Entra ID](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth),
  supporting personal Microsoft accounts *and* organizational accounts if both Outlook.com and
  Microsoft 365 tenants are targets — a different registration-audience choice than Gmail's
  single-Google-Cloud-project model, another axis the seam's per-provider config needs room for.
- **Delegated scopes** (the relevant flow for a personal mail client, as opposed to the
  admin-consent client-credentials flow meant for organization-wide app access): `IMAP.AccessAsUser.All`,
  `SMTP.Send`, `POP.AccessAsUser.All`, plus `offline_access` to receive a refresh token at all —
  without requesting `offline_access` explicitly, Microsoft's identity platform will not issue one
  ([per Microsoft's own docs](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)).
- **Same XOAUTH2 wire format** as Gmail (§5.1) — `AUTHENTICATE XOAUTH2 base64(...)` — confirming the
  seam can genuinely share one SASL encoder across both OAuth providers.
- **A distinct redirect-trust quirk** exists in Microsoft's Autodiscover (§1.3, §2's table) that
  doesn't apply to OAuth token flows themselves but is worth flagging for whoever builds the OAuth
  variant later: Microsoft's cross-domain Autodiscover redirects need explicit trust decisions,
  which is a different concern from OAuth's own redirect-URI allowlisting (standard OAuth
  authorization-code-flow hygiene) but easy to conflate if Autodiscover is ever added alongside
  OAuth for this provider.

### 5.3 Shared shape, across both providers

- **Access token + refresh token, not one static secret.** Both providers hand back a short-lived
  access token plus a longer-lived refresh token; the stored credential has two mutable fields
  (access token, refresh token) plus provider-specific client metadata, not one opaque string —
  materially different from `password`'s single write-only secret ([ADR-0003](../adr/0003-instance-held-credential-key.md)).
- **Silent background rotation.** Access tokens expire on the order of an hour; a syncing backend
  needs to refresh proactively (or on 401) without user interaction, as long as the refresh token
  itself is still valid — this is new lifecycle behavior `password` never needs, since a password
  doesn't expire on its own schedule.
- **A reauth trigger that isn't "wrong password."** Both providers can invalidate a refresh token
  server-side for reasons that have nothing to do with the immediate sync attempt (Google: password
  change, 6 months idle, 100-token cap eviction; Microsoft: admin revocation, conditional access
  policy changes) — the *Needs Reauth* state ([CONTEXT.md](../../CONTEXT.md)) already exists for
  rejected `password` credentials and is the right landing state for a dead refresh token too, but
  the trigger condition for `oauth` is "refresh call fails," not "the sync connection got a login
  error," which are different failure points in the pipeline.
- **XOAUTH2 as the one new SASL mechanism**, shared verbatim across Gmail and Microsoft (§5.1, §5.2)
  — worth building once, not per-provider.

---

## 6. Recommended seam shape

This section describes the interface shape `password` should already have, so `oauth` is a second
variant rather than a rewrite — not an OAuth implementation.

**Credential as a tagged union, one variant live at PoC.** [ADR-0003](../adr/0003-instance-held-credential-key.md)
already commits to this: "The stored credential is a tagged union (`password | oauth`) from the
first schema. Only `password` is populated at PoC; Gmail and Outlook slot in as a new variant rather
than a migration." Section 5 above is the concrete argument for *why* that union needs to carry, at
minimum:

```
credential =
  | { kind: "password", secret: <AEAD-sealed> }
  | { kind: "oauth",
      provider: "google" | "microsoft",
      accessToken: <AEAD-sealed, short-lived>,
      refreshToken: <AEAD-sealed, longer-lived>,
      expiresAt: timestamp,
      scope: string[] }
```

— i.e. `oauth` is not one more secret string, it is a small state machine (valid / expiring /
needing refresh / needing reauth) layered on top of the same sealed-at-rest storage `password`
already uses (same AEAD, same Mail-Account-id-as-associated-data scheme, same `key_version`
rotation — none of that changes per credential kind).

**A per-provider connection-config surface, separate from the credential.** Section 5.1 flags that
Gmail needs an OAuth client id/secret at the *instance* level (not per Mail Account), and Section
5.2 flags that Microsoft's app registration has a different audience/scope shape than Google's. The
seam should already separate "how do we *connect and authenticate*" (host, port, TLS, credential)
from "what does this *provider* need configured once, instance-wide" — the latter doesn't exist yet
for `password` (privateemail needs no client registration), so it's tempting to skip it, but adding
it after the fact for `oauth` is exactly the "quiet refactor" this ticket is trying to avoid. A
`provider` concept — `privateemail`/generic-IMAP now, `google`/`microsoft` later — that can
optionally carry instance-level config (client id/secret) is the shape to leave room for, even
though nothing populates it yet.

**One SASL/auth abstraction the sync engine calls, not two.** Whatever talks IMAP/SMTP should ask
the credential "give me an auth mechanism for this connection attempt" and get back either a
plain-auth (`LOGIN`/`PLAIN`, username + secret) or an `XOAUTH2` mechanism (username + bearer token) —
the IMAP/SMTP client code should not need an `if (credential.kind === "oauth")` branch scattered
through the sync engine; the credential variant should already know how to authenticate a
connection, and only the token-refresh step (which requires network I/O the credential itself
shouldn't own) needs to happen one layer up, before a sync attempt, keyed off `expiresAt`.

**Manual-entry / autodiscover output already has to be provider-agnostic host/port/TLS**, which it
already is per [poc-scope.md](../poc-scope.md#sync--accounts) ("falling back to manual host/port/TLS
entry for IMAP and SMTP") — Section 4's flow produces exactly that shape regardless of mechanism, so
no change needed there; the only addition OAuth needs on the *setup flow* side (not the credential
storage side) is a branch at the very start — "sign in with Google/Microsoft" instead of "enter
host/port" — that skips autodiscovery and manual entry entirely, since OAuth-connected accounts
don't need either (the provider's own IMAP host is fixed and well-known once a provider is
selected).

**Needs Reauth already covers the landing state; the trigger just needs a second door.** Nothing
about [the existing Needs Reauth state](../../CONTEXT.md) needs to change — it already stops syncing
and holds pending Optimistic Actions correctly for any Mail Account, regardless of credential kind.
The only shape decision is upstream: a refresh-token failure (Section 5.3) needs to be recognized as
a Needs-Reauth trigger alongside an IMAP/SMTP login rejection, not treated as a generic sync error.

---

## Open items for whoever builds the OAuth variant

- Confirm privateemail's actual `config-v1.1.xml` content against a live customer domain (§3.1's
  verification gap) before finalizing the autodiscover parser's field expectations.
- Decide the Gmail OAuth client distribution model — one shared client id shipped with the project
  vs. per-instance self-registration (§5.1) — before building the `google` provider config surface;
  this is a product/ops decision, not just a technical one, and affects whether Google's
  verification/CASA-audit cost is borne once (by the project) or per self-hoster.
- Re-check Microsoft's SMTP AUTH basic-auth timeline before shipping — it was explicitly still
  moving as of this research (delayed once already, final removal date not yet announced per
  Microsoft's own updated timeline, §5.2) and affects how urgent the Outlook `oauth` variant is
  relative to other post-PoC work.
