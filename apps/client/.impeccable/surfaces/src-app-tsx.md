---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/mail/MailSection.tsx","src/mail/ListView.tsx","src/mail/ThreadRow.tsx","src/mail/screener/Screener.tsx","src/compose/Composer.tsx","src/auth/AppShell.tsx","src/auth/LoginForm.tsx","src/settings/SettingsSection.tsx"]
---

# Wicket — the client, end to end

Scope: every screen `apps/client` renders (claim/login, triage list, thread, composer,
Screener, search, settings), plus the repo-facing marks. Visitor mode: **Operate**.

Audience: people leaving Gmail who will not hand their mail to another service; they judge
the project cold from a repo page before they ever run it. Task: triage a list at speed,
dozens of times a day, desktop and phone. Register: calm on first open, expert underneath.
Ruled out by the user: anything that reads as a homelab tool, anything too loud to live in
all day.

Memorable moment: **the strike.** A triage decision lands as a rubber-stamp overprint struck
across the item — wet at first, setting when the server confirms, lifting on rollback. The
optimistic-action model made visible in the material.

Unresolved: licensing; Gmail/OAuth; trademark clearance on "Wicket" (Apache Wicket collision
accepted by the user).

## Direction contract

**THESIS:** The inbox is the room mail is processed in, not a feed of it. Triage state is
struck across the item, never badged beside it. Refuses the three-pane card list on grey.

**OWN-WORLD:** Sorting-frame ground (warm near-black; institutional pale grey-green in
light), compartments divided by hairline rules — no cards, no shadows, radius ≤2px. Inset
label-holder plates head every region. Archivo variable (width axis = label stock) with
Martian Mono for codes; self-hosted, no font CDN. Roles: aniline violet ink, fluorescent
orange HELD, postal red returned, phosphor green admitted.

**STORY:** This holds mail from strangers until you say otherwise, and the server is yours.

**FIRST VIEWPORT:** Sorting frame, left stile as the governing axis. Tray-label header:
folder legend condensed caps left, fluorescent HELD plate right. Rows on hairline rules —
kraft initial plate on the stile, sender, subject, snippet, tabular time hard right. Day
dividers are facing bands. Compose is a plate on the frame, not a floating button.

**FORM:** The Sorting Office — candidate 1 of 7, Impeccable's pick, chosen over the roll.
Seed key 8b0f0098, code-led.

**RAISES:** State restyles a row inside its columns, never adds chrome (Split-Flap). Rank by
inversion, not weight; controls take no signal colour (Depot Blind). Destructive actions get
deliberate empty space, outline until focused (Dev Console). Grotesque stays small; identity
rides structure and one drenched room (Dumbar). One governing axis at every level
(Mesophotic). A thread carries the record of what was done to it (Orizuru).

**SIGNATURE INTERACTION:** The strike — an off-register overprint on the outgoing row,
transform/opacity only, never delaying the next keystroke, off under reduced motion. The
Screener is the one drenched room: fluorescent orange, one facing slip per stranger, admit
or return.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish
review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
