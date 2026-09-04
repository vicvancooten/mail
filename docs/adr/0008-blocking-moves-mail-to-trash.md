# Blocking moves mail to Trash

A Gatekeeper Verdict is an App Feature — IMAP has no concept of "I don't want to hear from this person" — but the *effect* of a Blocked Verdict is a real IMAP move: when mail from a Blocked Sender arrives, the Sync Backend moves it to the Mail Account's `\Trash` folder before it ever surfaces in the Client. This is a deliberate, narrow exception to [ADR-0006](./0006-app-feature-state-lives-in-sync-backend.md)'s default, and it clears that ADR's own promotion bar: every provider has a Trash folder, and "delete this mail" is as clean and universal a mapping as IMAP offers.

## Considered Options

- **App Feature hide** (the Verdict filters the message out of every view, mail stays in the Inbox on the server): rejected — a block that leaves the mail sitting in your Inbox isn't a block. Any other IMAP client, any provider-side notification, and any future re-sync would still surface it, and the user's stated expectation is that a blocked sender is actually blocked.
- **Server-side Sieve rule via ManageSieve** (the mail never reaches the Inbox at all): rejected for the PoC — strongest mechanism, but it requires provider support that is unverified for the target provider, and it creates a second source of truth for blocking that can drift from the Verdict table. Worth revisiting post-PoC.
- **Moving to `\Junk` instead of `\Trash`**: rejected — Junk is the spam filter's territory, some providers auto-purge or re-scan it, and filing personal preferences there corrupts a signal we don't own. Reporting spam is a separate action, deferred post-PoC.

## Consequences

- Blocking is destructive on a delay: mail lands in Trash, and most servers auto-purge Trash after ~30 days. Unblocking is therefore always future-only — it stops the bleeding but recovers nothing. Accepted; the Blocked Senders list in Settings keeps the mistake correctable in the way that matters.
- The move is visible to every other IMAP client against the same Mail Account, unlike Pin, Label, Snooze and the Screening Hold. That asymmetry is intended: hiding mail is a view concern, disposing of it is a mailbox concern.
- The Screening Hold itself stays an App Feature exactly as ADR-0006 specifies — held mail is filtered out of the Inbox view, never moved. Only the Blocked branch touches IMAP.

## Amendment (#90): Spam is the decision that speaks to `\Junk`

The "moving to `\Junk`" option above stays rejected *for Block*. A separate Gatekeeper decision,
**Spam**, now exists: it Blocks the sender exactly as above and additionally moves their held and
future mail to the Mail Account's Junk special-use folder rather than Trash, so the provider's own
filter learns from it. The two claims — "I don't want this" and "this is spam" — are different, and
only the User can tell them apart, which is why Spam is a deliberate extra click in Block's split
menu and never the default. "Reporting spam" post-PoC is therefore resolved as this IMAP move; a
provider-specific report API is not planned.

## Amendment (#90): a Verdict may be keyed to the recipient

Verdicts were keyed to the sender's address or domain. A third scope, **Blocked Alias**, keys a
Blocked Verdict to an address of the User's own that mail *arrived at* — a catch-all Alias that
leaked. Mail arriving at a Blocked Alias is moved to Trash on arrival regardless of sender, beating
even an Approved Sender, because the Alias itself is what the User has given up on. The recipient is
read from `Delivered-To` / `X-Original-To` first and `To`/`Cc` second, since spam to a catch-all
usually arrives Bcc'd. The Screener offers it behind a warning that names the exact Alias it will
silence. Server-side Sieve rules remain the future promotion path for all three block scopes and
remain deferred for the reasons above.
