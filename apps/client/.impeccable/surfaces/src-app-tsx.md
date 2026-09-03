---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/mail/MailSection.tsx","src/mail/ListView.tsx","src/mail/ThreadRow.tsx","src/mail/screener/Screener.tsx","src/compose/Composer.tsx","src/auth/AppShell.tsx","src/auth/LoginForm.tsx","src/settings/SettingsSection.tsx"]
---

# The Instrument — the client, end to end

Scope: every screen `apps/client` renders (claim/login, triage list, thread, composer,
Screener, search, settings), plus the repo-facing marks. Visitor mode: **Operate**.

Audience: people leaving Gmail who will not hand their mail to another service; they judge
the project cold from a repo page before they ever run it. The register they arrive with is
Linear, Arc, Superhuman. Task: triage a list at speed, dozens of times a day, desktop and
phone. Register: calm on first open, expert underneath. Ruled out by the user: anything that
reads as a homelab tool.

Loudest moment: reverse-chronological rank expressed as scale. The Thread list groups by
recency; the newest tier is visibly the loudest thing on screen (size, ink, avatar) and older
tiers taper down to one **Older** catch-all — a User can see what is new without reading
dates, and a long list still has a shape to scan.

Unresolved: licensing; Gmail/OAuth; trademark clearance on "Wicket" (kept for this build,
reconsidered in its own ticket); whether collapsible groups survive the stack; whether losing
shareable search URLs proves acceptable across a release.

## Direction contract

Supersedes the prior Wicket/"sorting office" contract this surface carried under #64 (history:
`docs/design/wicket-identity.html`, due its own superseded-by header once `DESIGN.md` is
regenerated at the tip of this stack, #84). Build target: the approved prototype
`docs/design/prototypes/the-instrument.html` (`prototype/the-instrument`, resting-state
screenshots in both themes under `docs/design/prototypes/screenshots/`); the prototype is a
throwaway concept check, not a component source, and wins wherever it disagrees with the prose
below.

**THESIS:** The Client reads as a precise, modern instrument a stranger trusts cold — never a
feed, never a homelab curio — and openly a growing personal hub, not a mail-only tool. It gets
faster to use the longer a mailbox lives in it, and never hides that more Apps are coming.

**OWN-WORLD:** Near-white ground in light, near-black in dark; one electric accent carries
every primary action, focus ring and selection. Compartments divided by 1px hairline rules —
no cards, no shadows past the overlay layer (popovers, dialogs only), radii 6–8px. A
**header-mounted App Switcher** (hub mark plus an expanding pill switcher) — not an icon rail
— names Mail (live) and Contacts / Calendar / Tasks (reachable placeholders). Mail keeps its
own left sidebar: Compose, then Inbox, Screener, Snoozed, Pinned, Drafts, Sent, Archive,
Trash, Labels. Inter Variable for running text; Martian Mono for tabular machine values —
timestamps, counts, sizes; self-hosted from the instance's own origin, no font CDN.

**STORY:** This is the inbox that gets faster the longer you use it: the newest mail is the
loudest thing on screen, a whole day clears in one gesture, and everything else is one
keystroke away in the palette.

**FIRST VIEWPORT:** Header: hub mark and App Switcher pill left, global search centred,
Account Scope and appearance/avatar right. Below it, Mail's own chrome: the folder sidebar,
then the Thread list — Pinned leading, then date groups tapering from loudest (Today) to
quietest (Older/Undated). Resting on, or tapping, a group header arms that group's own
**two-action** cluster — **Done all** and **Mark all read**; group Snooze is dropped, since
snoozing is a per-Thread decision. Compose is a sidebar entry, not a floating button.

**FORM:** The Instrument — candidate 1 of 7, Impeccable's pick, chosen over the assigned
alternative (The Session, a DAW-console world). Seed key `62187dfb`.

**RAISES:** Hierarchy comes from scale, never *decorative* badges — unread state and
actionable counts (held mail in the Screener, unsent Drafts) still show, because a number that
is a call to action is not decoration. A row's own actions live in reserved space and never
shift the row on hover/arm. Destructive actions get deliberate empty space, outline until
focused. One governing axis at every level: the header for the whole instance, the sidebar for
Mail, the taper for recency within a folder.

**SIGNATURE INTERACTION:** The command palette (`⌘K`) is the keyboard surface for the whole
Client — every action with its binding, and the only entry point to search. Typing shows top
hits; "see all results" hands the full result set to the list pane while the reading pane
stays live beside it. On the list itself, resting or tapping a date-group header arms its
Done all/Mark all read inline; a bulk Done stages the first rows out, then collapses the group
as one. Both are transform/opacity motion, off under reduced motion.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review,
the verdict, a regenerated `DESIGN.md`, and every shipping raster carrying its provenance.
