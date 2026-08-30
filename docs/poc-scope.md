# PoC scope & feature tiers

Resolution of wayfinder ticket [#2](https://github.com/vicvancooten/mail/issues/2). This is the scope
contract for the PoC: what gets built before Vic dogfoods, what waits. The full PoC *spec* is
[#14](https://github.com/vicvancooten/mail/issues/14) and folds this in; where the two disagree, this
document is the older one.

## What the PoC is

A build Vic uses to triage his real mail every day, on his own hardware, instead of Spark. One User
(the Owner) on a multi-user-capable system: `User` is in the schema and the API from day one
([ADR-0004](adr/0004-mail-account-belongs-to-one-user.md)), but the flows for inviting Members and
recovering accounts are not built yet. It ends when Vic has gone two weeks without opening Spark to
process mail.

**Benchmark**: beat Spark desktop/web outright on speed; match Spark mobile's responsiveness.
Superhuman is inspiration, not a bar to clear.

**Providers**: privateemail only — IMAP + SMTP with a password. Gmail is the first thing added after
the PoC, and a 15-year Gmail archive is the reason the scale bar below exists.

## In the PoC

### Sync & accounts

- Multiple Mail Accounts syncing concurrently; everything keyed by Mail Account in the data model,
  the sync engine, and the API. Per-account inboxes with an account switcher.
- Password / app-password authentication only, behind a provider seam where `password` and `oauth`
  are peers ([ADR-0003](adr/0003-instance-held-credential-key.md)) so Gmail OAuth is additive later.
- Adding a Mail Account is a **separate, repeatable step** from creating the User: the first-run
  wizard creates the Owner, then "add a Mail Account" is its own flow, run once per account.
- Autodiscover from the email domain (SRV records, then Mozilla's ISPDB), falling back to manual
  host/port/TLS entry for IMAP and SMTP.
- Full-history backfill, newest first, with lazy bodies ([ADR-0005](adr/0005-typescript-sync-backend.md)).

### Auth

Username + password (argon2id), TOTP, and passkeys. Opaque DB-backed session in an httpOnly cookie,
never wiping the Client's local store on expiry. CLI escape hatch for reset. No invite links, no
System Mailer recovery flow — the `AuthMethod` seam from
[#7](https://github.com/vicvancooten/mail/issues/7) stays, so those are additive.

### Reading

- Threaded message list with time-grouping headers.
- Sanitized HTML rendered in a sandboxed iframe. Remote images blocked by default and loaded
  automatically for Approved Senders — the Gatekeeper verdict *is* the image-loading permission.
- Attachment download, with inline preview for images and PDFs.

### Triage

Archive, trash, read/unread, star, pin, label, auto-advance. Labels are apply / remove / filter-by
only — no label management UI, colors, or nesting. Every action is optimistic with visible rollback;
offline shows last state and queues actions, draining on reconnect.

### Compose & send

Rich text (HTML + plaintext multipart), attachments, server-side synced drafts with autosave, one
plain-text signature per Mail Account, Undo Send, recipient autocomplete derived from synced message
history, correct `In-Reply-To` / `References` threading.

### Search

Headers and message bodies across the full backfilled history. Attachment contents are not indexed.
Where search executes is [#11](https://github.com/vicvancooten/mail/issues/11)'s call.

### Gatekeeper v1

In scope, and **built last** — it is the reason the project exists, so the daily-use test is
meaningless without it, but sequencing it last means it can be cut without stalling anything else.
Spec: [#12](https://github.com/vicvancooten/mail/issues/12).

### Clients & notifications

Desktop and phone PWA, both good. Installable to the homescreen (on iOS this is also what makes Web
Push possible at all), swipe gestures on touch.

Push rules:

- Mail from an Approved Sender landing in the Inbox fires a push.
- Held mail fires **one coalesced Gatekeeper notification** naming the senders ("3 held: A, B, C"),
  on the first hold, then suppressed for 4 hours.
- Blocked and Unscreened mail never pushes otherwise.
- One on/off toggle per Mail Account, nothing finer.

### Preferences

Theme (dark / light / system), list density, layout switching, auto-advance on/off and direction,
per-account plain-text signature, per-account notification toggle.

### Deployment

A compose file in the repo, **plus published versioned container images on GHCR and
migrate-on-boot** — upgrading mid-dogfood has to be safe, not a nightly adventure. Full self-hoster
docs, TLS/reverse-proxy recipes, and backup guidance are a public-release task, not a PoC one.
Scoped in [#19](https://github.com/vicvancooten/mail/issues/19).

## Acceptance bar

The PoC is done when all of these hold:

| | Bar |
|---|---|
| **Daily driver** | 14 consecutive days triaging real mail without opening Spark to process the inbox |
| **Cold start** | < 1s to an interactive list on desktop |
| **Thread open** | < 100ms, served from the local store — never a network wait |
| **Triage action** | < 50ms to visible effect |
| **Search** | < 200ms to first results over full history |
| **Keyboard** | a complete inbox pass — read, archive, trash, star, pin, label, reply — without the mouse |
| **Mobile** | installed to homescreen, swipe-to-archive, push on a locked phone, scroll and open feel equivalent to Spark mobile |
| **Correctness** | zero lost or duplicated messages; every Optimistic Action reconciles or visibly rolls back; cold boot with the backend down shows last state and queues actions; reconnect drains the queue |
| **Gatekeeper** | a week with no Unscreened Sender reaching the Inbox and no wanted mail misfiled |

### Scale

Every speed target above must hold against a **seeded synthetic corpus of 250,000 messages / ~80,000
threads across 2 Mail Accounts**, not just against Vic's privateemail traffic. Gmail's 15-year
archive arrives immediately after the PoC, so "architect for scale" is a failing test rather than an
intention. This bar is expected to constrain
[#11](https://github.com/vicvancooten/mail/issues/11) — a pure client-side index may not survive it.

## Post-PoC

Deferred to the follow-up map ([#15](https://github.com/vicvancooten/mail/issues/15)), roughly in
the order they matter:

1. **Gmail / Outlook OAuth** — next up after the PoC.
2. **CardDAV contacts** — soon after; becomes an additional source behind the same autocomplete, not
   a replacement for history-derived suggestions.
3. **Snooze, batch actions, automation rules** — all wanted, none blocking daily triage.
4. Scheduled send, rich-text signatures.
5. Unified / merged multi-account inbox (the data model already supports it; this is presentation).
6. Attachment-content search.
7. Per-thread mute, VIP-only pushes, quiet hours.
8. Invite links and System Mailer recovery flows.
9. Calendar, sender avatars.
10. Public self-hoster documentation, TLS/backup guidance.
11. Native apps.
