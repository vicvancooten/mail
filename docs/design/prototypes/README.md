# Design prototypes

Throwaway, single-file HTML mockups used to review a locked direction contract with the user
before implementation starts — static markup and mock data only, no build step, no wiring into
the real app. Open a prototype's `.html` file directly in a browser to view it.

## the-instrument.html

Concept check for **The Instrument** — the direction locked for the client's visual rework
(replacing the "sorting office" identity shipped in #64). Direction contract:
`apps/client/.impeccable/surfaces/src-app-tsx.md` (`## Direction contract`, seed key
`62187dfb`). Tracked in [#66](https://github.com/vicvancooten/mail/issues/66).

Demonstrates the app-switcher shell (Mail live, Contacts/Calendar/Tasks named and disabled),
the reverse-chronological timeline spine with group-scoped hover previews, and Done (archive)
as the primary triage action living in reserved space left of each avatar — never overlapping
it. `⌘K` opens a command palette; `j`/`k` navigate the list; the header's theme toggle switches
light/dark.

Screenshots (resting state, both themes) are under `screenshots/`.

Not addressed here: the actual Contacts/Calendar/Tasks screens, or the product name/mark
(`Wicket` and the postmark are open for reconsideration — see the direction contract).
