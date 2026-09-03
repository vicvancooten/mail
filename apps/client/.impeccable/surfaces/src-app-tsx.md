---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/mail/MailSection.tsx","src/mail/ListView.tsx","src/mail/ThreadRow.tsx","src/mail/screener/Screener.tsx","src/compose/Composer.tsx","src/auth/AppShell.tsx","src/auth/LoginForm.tsx","src/settings/SettingsSection.tsx"]
---

# Wicket — the client, end to end (name under reconsideration)

Scope: every screen `apps/client` renders today (claim/login, triage list, thread, composer,
Screener, search, settings), plus the repo-facing marks — built now for a single-app shell
that visibly makes room for a personal hub (Contacts, Calendar, Tasks) via a real app
switcher. Visitor mode: **Operate**.

Audience: people leaving Gmail who will not hand their mail to another service; they judge
the project cold from a repo page before they ever run it. Task: triage a list at speed,
dozens of times a day, desktop and phone. Register: calm on first open, expert underneath —
closer to Linear/Arc/Superhuman's register than an institutional one. Ruled out by the user:
anything skeuomorphic, anything that reads as 2010s-dated, anything that reads as a homelab
tool or as a hosted SaaS holding their mail hostage.

Memorable moment: **the hover-armed group.** Resting the pointer on a date-group header
("Today", "Last week", "August") arms that group's own bulk-action cluster (Archive all /
Mark read / Snooze) inline, instantly — the same reveal a single row gets for its own
actions. Reverse-chronological rank is felt, not just positioned: the newest group is
visibly the loudest thing on the screen.

Unresolved: licensing; Gmail/OAuth; the product name and mark ("Wicket" and the postmark are
open for reconsideration per this round — the postmark drawing itself tested well with the
user and stays a live candidate, but nothing is locked); the actual Contacts/Calendar/Tasks
screens are out of scope for this pass — only the switcher and the system's proven ability to
hold them is in scope. This round intentionally stops at a locked direction contract; the
build itself is planned as a follow-up.

## Direction contract

**THESIS:** A precision instrument operated at speed, not a room to stand in. Refuses
sorting-office skeuomorphism and the generic three-pane card list on grey; hierarchy comes
from scale, never ink or badges.

**OWN-WORLD:** Near-white/near-black ground, one electric accent, 1px hairline dividers, no
cards or shadows past the overlay layer, 6–8px radii, tabular mono for machine values.
Icon-only app rail: Mail lit, Contacts/Calendar/Tasks named and dimmed "soon." Command-K
reaches everything.

**STORY:** Recognizes the register at once: the tool of someone who already runs Linear,
Arc, or Superhuman, now expecting that same speed from their own mail server.

**FIRST VIEWPORT:** App rail far left. List pane: search + compose, then sticky pill group
headers — Today largest, tapering through Yesterday, Last week, August. Hovering a header or
a row arms its own bulk-action cluster from the right. Reading pane fills the rest.

**FORM:** The Instrument — Impeccable's Pick, ranked 1 of 7 (the roll assigned The Session, a
DAW-console world, at index 5; the user chose the pick over it). Seed key 62187dfb, code-led.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish
review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
