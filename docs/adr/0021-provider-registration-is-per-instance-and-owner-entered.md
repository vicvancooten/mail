# Provider Registration is per-instance and Owner-entered

Signing in with Google or Microsoft needs an OAuth app registered with that Provider. Each instance's
**Owner registers their own** (a Google Cloud project, an Entra app registration) and pastes the
client ID and secret into the Instance page, where they are stored in a dedicated
`provider_registrations` table sealed with the instance credential key
([ADR-0003](0003-instance-held-credential-key.md), Provider name as associated data). The same
page is **Provider Health**: per Provider, whether a Registration exists, whether a Grant has ever
been obtained through it, and whether Grants are currently being refreshed, with the exact redirect
URI to copy and the setup steps beside the fields. Decided in the #91 grilling, 2026-09-04.

## Considered Options

- **One shared client ID shipped with the project, as Thunderbird does**: rejected — Gmail's IMAP
  scope (`https://mail.google.com/`) is Google's *restricted* tier, and publishing an app that
  requests it puts a recurring CASA Tier 2 security audit on whoever owns the client. A
  self-hosted household project should not carry that for every stranger's instance, and Google's
  100-user cap on unverified apps would be shared across all of them. Per-instance registration
  keeps every Owner under their own cap and their own consent screen.
- **Client ID and secret as env vars, following the VAPID-pair precedent**: rejected, narrowly.
  It is the cheapest and matches every other instance-level knob, but the issue asks for *easy*
  setup: a form the Owner fills once, without a restart, that turns into a health readout, beats a
  compose-file edit plus a read-only mirror of it. It is the first instance-level state in the
  database; a dedicated table rather than a generic settings bag, so the next knob still has to
  earn a shape.

## Consequences

- **The Owner's instructions must say "set the Google app to In Production".** An External app
  left in Testing status issues refresh tokens that expire after seven days, which would land
  every Gmail Mail Account in Needs Reauth weekly for no visible reason. Unverified-in-Production
  is fine for a household; the consent screen shows a warning once. A Google Workspace Owner can
  register an Internal app instead and skip this entirely.
- **The Microsoft registration targets personal *and* work/school accounts** (the `common`
  authority): free at registration time, but an M365 tenant can disable IMAP or require admin
  consent, and that surfaces to the User as a failed sign-in with a plain message, not as something
  the instance fixes.
- **Members cannot fix a missing Registration**, so an unregistered Provider is shown as
  unavailable when adding a Mail Account ("not set up on this instance yet, ask the Owner"), never
  hidden; the Owner sees the same choice with a link to Provider Health.
- **Neither Provider can validate a client ID and secret without a User consenting**, so Provider
  Health is honest about "Registered, untested" until the first Grant lands; "Working" and
  "Failing" are derived from the last token refresh, not from a probe.
- **Redirect URIs derive from `PUBLIC_URL`**, already the declared single source of truth for
  cookies, WebAuthn and Web Push; Google rejects a plain-http, non-loopback redirect, and the
  Instance page already knows whether the URL is a secure context.
- **Grants live on the Mail Account, in the existing `oauth` credential variant**, and a refresh
  failure that the Provider reports as a withdrawn grant is a second door into Needs Reauth
  beside a rejected login. Reauth for such an account is signing in again, never a password form,
  and a Gmail account added with an app password can switch to a Grant on the same Mail Account
  provided the signed-in address matches.
