# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary:** people who want out of Gmail but will not trade their mail to another
inbox-as-a-service. Wider than the homelab crowd — the audience is anyone who has decided their
mail should live on hardware they control, including people who need a friend or a one-page guide
to get there. They evaluate the project cold, from a repository page, before they trust it with
fifteen years of correspondence.

**Operator vs. User are the same person at first, then diverge.** The **Owner** deploys the
instance and is the only role that can invite others and change instance settings; **Members** get
full control of their own Mail Accounts and no say over the instance. A household or a small team
on one instance is a real shape, not an edge case.

**The daily job** is triage, not reading: processing a list — archive, trash, star, pin, snooze,
label, approve or block a sender — many times a day, on a phone in one hand and on a desktop with
both. Speed at that job is the whole point.

## Product Purpose

A fast, modern, self-hosted email client. A **Sync Backend** talks to the user's existing mail
servers over IMAP/SMTP and holds the authoritative store of all mail and Triage state; **Clients**
talk only to the Sync Backend, never to a mail server, and keep a deliberately disposable **Local
Cache** of just the slice being triaged.

Success is behavioral, not feature-count: the author stops opening Spark to process mail, and
someone who is not the author can deploy an instance and stay on it.

## Positioning

Two claims a neighbor cannot truthfully copy at once:

1. **Gatekeeper is the reason the project exists.** Mail from an Unscreened Sender is held in the
   **Screener** until the user decides — one decision per stranger, not per message. A triage
   control, not a security control. Hosted products with a screener do not let you own the server;
   self-hosted clients that let you own the server do not screen. A Verdict is scoped to a single
   Mail Account, so a decision never leaks across accounts or users.
2. **Speed is an architectural position, not a benchmark to chase.** The store-as-truth model with a
   pending-mutation overlay (ADR-0010), optimistic actions that survive a reload and work offline,
   and a bounded Local Cache exist so that triage is instant on a fifteen-year mailbox. Stated bar:
   beat Spark desktop/web outright, match Spark mobile's responsiveness. Superhuman is inspiration,
   not a bar to clear.

Consequence for the identity: the product must read as **fast and owned**, and it is evaluated cold
by someone deciding whether to trust it — so it cannot look like a weekend project, and it cannot
look like a SaaS that will hold their mail hostage.

## Operating Context

- **Deployment** is `docker compose up -d` against versioned GHCR images, with the operator bringing
  their own reverse proxy and TLS. Two services, one image (ADR-0009). Upgrades and rollbacks are a
  documented ritual, and backups are the operator's job.
- **Daily use** is a PWA, installed to the homescreen on both desktop and phone — on iOS that
  install is also the only thing that makes Web Push possible at all. Swipe gestures on touch.
- **Evaluation** happens on a repository page, in a README, on a GHCR listing, and in whatever
  preview card the link generates in a chat app — before the app is ever seen running.
- **Interruption** is deliberately narrow: mail from an Approved Sender pushes; held mail fires one
  coalesced Gatekeeper notification naming the senders, then suppresses for four hours; blocked and
  unscreened mail never pushes otherwise. One on/off toggle per Mail Account, nothing finer.

## Capabilities and Constraints

**Surfaces the client renders today:** first-run claim and login (password, TOTP, passkeys), the
authenticated shell, the triage list (stream and split layouts, compact/comfortable density),
thread reading with sanitized HTML in a sandboxed iframe, attachment list with inline image and PDF
preview, a TipTap composer with attachments, drafts, signatures, slash menu and Undo Send, search
results, the Screener, and settings (preferences, auth methods, Mail Accounts, Gatekeeper, push).

**Constraints the design inherits:**

- React 19 + Vite SPA (ADR-0002), PWA with a hand-written app-shell-only service worker.
- Message bodies are third-party HTML rendered in a sandboxed iframe. The design system stops at
  that boundary; the identity cannot restyle what senders wrote.
- Remote images are blocked by default and load automatically only for Approved Senders — the
  Gatekeeper verdict *is* the image-loading permission.
- Density and layout are **Device Preferences**: they deliberately never sync, because they mean
  different things on a phone and a desktop.
- Safe-area insets matter: the layout paints under the iOS notch and home indicator.
- Terminology is fixed and non-negotiable in UI copy — see `CONTEXT.md`. Thread, not conversation.
  Mail Account, not mailbox. Screener, not quarantine. Star and Pin are different things on purpose.
- **Undecided:** licensing (`docs/research/0002-licensing-options.md`), and Gmail/OAuth support,
  which is the first thing added after the PoC.

## Brand Commitments

**None are binding.** Confirmed in this session: the name "Mail" is a working title, the purple bolt
in `apps/client/public/favicon.svg` (#7e14ff) is unowned, the `V` app icons are placeholders, and
the periwinkle `--mail-accent: #6c8cff` in `mail.css` was never chosen. The identity work names the
product and sets the marks.

**Reach required of the identity in this pass:** the app end to end, plus the repo-facing marks —
favicon set, PWA app icons (any and maskable, 192 and 512), apple-touch-icon, social/preview card,
README header. It must be able to carry a marketing surface later without a rebrand, but no
marketing surface is in scope now.

## Evidence on Hand

- Real domain glossary with enforced vocabulary: `CONTEXT.md`.
- 16 architecture decision records under `docs/adr/`, and research notes under `docs/research/`
  including a 250k-message corpus benchmark (`0007`) and iOS PWA push/badging constraints (`0006`).
- A working, tested client: 49 components, ~1,900 lines of hand-written CSS in `mail.css` and
  `compose.css`, and a Vitest suite covering sync, store, compose, and PWA behavior.
- Installation and dev-setup guides that a stranger can follow.

**Absent, and not to be invented:** users, testimonials, install counts, stars, press, uptime or
deliverability figures, pricing, a license, and any published performance number. The Spark
comparison is an internal bar, not a published claim.

## Product Principles

1. **The Screener is the product.** Whatever else the identity does, a stranger must understand that
   this inbox holds mail from strangers until you say otherwise.
2. **Owned, not hosted.** Every surface should make it obvious the server is yours. Nothing may
   imply a service standing between the user and their mail.
3. **Speed is felt, never claimed.** Instant response is demonstrated by the interface behaving that
   way — optimistic, snap-instant on repeated actions — not by a number on a page.
4. **Triage is the register.** The default state is a list being processed at speed by someone who
   already knows the keyboard, not a mailbox being browsed.
5. **Trust is earned cold.** The identity is judged before the app runs. It has to look like
   software someone maintains.

## Accessibility & Inclusion

No product-specific standard was established. Baseline obligations that the surfaces already imply:
full keyboard operation of triage (j/k navigation and action shortcuts are core, not an
affordance), visible focus, respect for `prefers-reduced-motion` given the existing entrance and
stagger animations, and legible contrast in both light and dark — the app already declares
`color-scheme: light dark` and the phone is used in both.
