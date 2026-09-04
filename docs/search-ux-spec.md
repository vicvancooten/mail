# Search UX spec

How search looks, reads and behaves in the Client. The counterpart to
[ADR-0016](adr/0016-search-runs-in-the-sync-backend-over-a-bounded-candidate-window.md), which fixes
where search *executes* (Sync Backend, Postgres FTS over a bounded Candidate Window) and what
crosses the wire (structured filter fields, a `Thread` list-row projection, no totals). Everything
here is the Client half: the surface, the query language, and the result list.

Resolves [Search UX: query syntax, filters & the search
surface](https://github.com/vicvancooten/mail/issues/29). Implemented by [Search UI & client
prefilter](https://github.com/vicvancooten/mail/issues/51).

## The surface

Search is an **overlay**, not a route (revised by #71 — see
[ADR-0017](adr/0017-search-has-no-route.md); it was `/search?q=<raw query string>` before the Client
had a router at all).

Revised again by #79 (the Command Palette): the Client's discoverability surface is now `⌘K`/
`Ctrl-K`, and the header search field is its other entry point — clicking or tapping it opens the
same overlay, focused on its own input, rather than becoming an inline field itself. (`/` still
focuses the header field directly with no Palette chrome, the fast path for someone who already
knows what they're typing.) The Palette lists **every command in the Client with its binding,
grouped by section**, unbound commands included — Mark read/unread among them, since #79 also
rebinds `h` (was "previous", now Snooze) and `u` (was mark‑unread, now "back to list"). `?` opens
the Shortcut Sheet, the same registry rendered read-only as a cheat sheet.

Typing in the Palette runs the same search this spec has always described — the 3-character floor,
the ~200ms debounce, the Local Cache prefilter — and shows the **top few hits inline**, in a
bounded, scrolling pane alongside the matching commands. **"See all results"** (or Enter on a hit)
commits the query exactly like the header field's own Enter always has, which is what activates
**the list pane behind the Palette**: it swaps into the results list — same row renderer, same
Triage affordances — with the reading pane still live beside it in Split, so a result is triagable
like any other row the moment the Palette stops covering it. The Index Watermark (below) surfaces
here too, next to the inline hits, whenever bodies are still being indexed.

There is one list renderer and one set of triage affordances; search is another list, not a second
application. This is what makes ADR-0016's "triage works on result rows" cheap: no modal to fight,
no second row component, no special case for acting on a result.

**Stream mode is suppressed inside search**, falling back to the underlying Split/List choice it
already remembers, and restores itself on exit. Stream is "read forward through everything new",
which is the opposite motion to a ranked result set.

### When a search runs

Live, debounced. The Local Cache prefilter renders on every keystroke; `POST /search` fires ~200ms
after typing stops, from **3 characters** (ADR-0016's floor — below it, nothing renders rather than
something bad).

The URL is **replaced** while typing and **pushed** on commit (Enter, or blur), so the back button
walks committed searches rather than eleven half-typed ones. Enter also means "search now, don't
wait" and dismisses the prefilter dropdown.

### Leaving, and coming back

- `Esc` with text in the Palette's field **clears the text**; `Esc` on an empty field **leaves
  search and closes the Palette**, same two-step `Esc` the header field always had. Browser back
  leaves in one press.
- Leaving **restores the origin exactly**: the folder, its scroll position, and the thread that was
  open in Split. Search is a place you dip into, not a mode you have to climb out of.
- The **query survives leaving**. `/` or `⌘K` reopens with the last query still in the field and its
  results still rendered, until cleared. (The scope chip is the exception — see
  [Seeded scope](#seeded-scope).)
- Opening a result in Split doesn't leave search at all. Selecting a hit straight from the Palette's
  inline list (rather than "See all results") behaves the same way: it opens that result and closes
  the Palette, leaving the list pane already showing results underneath.
- Closing the Palette without touching the query — clicking its backdrop, or its own Close button —
  leaves whatever was already on screen exactly as it was: the Palette is a layer *over* the current
  view, not a mode it swapped into.

### Phone

At phone width a **search icon in the top bar opens the Command Palette full-screen** (#79) —
there's no room beside it to expand a field in place, so the icon is a dedicated Palette trigger
rather than the desktop click-to-open field. Everything above still applies at that width: commands
and top hits inline, "See all results" swapping in the real results list, tapping a result pushing
the thread route and back returning to the results. The chip row sits under the field and scrolls
with the results.

Same parser, same renderer, same registry — the phone is a layout of this spec, not a second
design. No dedicated search tab (a permanent slot for a bursty action, with its own navigation stack
fighting origin-restore) and no pull-down-to-reveal (undiscoverable, and it fights pull-to-refresh).

### The empty field

Focusing an empty field shows the **last ~5 recent searches**, clickable to re-run, with a clear
action. Stored as a **Device Preference** — a per-device convenience, and a small privacy footgun on
a shared machine, which is why the clear is not optional.

Because the query string is the truth, a recent search *is* its string: re-running one is a route
change and nothing more.

No suggested scopes in the empty state. The chip row already surfaces those while searching, which
is when they mean something; in an empty field they are guesses dressed as help.

## The query language

**The raw text is the source of truth.** The parser is a pure `string → filter fields` function in
the Client; the string is what lives in `?q=`, what is stored as a recent search, and what the user
edits. Chips and toggles work by *editing that string*, never by holding state beside it.

This is the seam ADR-0016 asks for — the backend never re-parses a query string — and it makes a
search a single shareable, bookmarkable, restorable URL.

### Operators

A closed set. Everything else is free text.

| Operator | Example | Notes |
| --- | --- | --- |
| `from:` | `from:vic` | Matches display name or address, per the Search Index's participant and address-part weights |
| `to:` | `to:team@…` | Includes `Cc` |
| `has:attachment` | | |
| `in:` | `in:trash`, `in:archive` | Folder scope; also the escape from the default Trash/Junk exclusion |
| `before:` / `after:` | `after:2024-01-01` | Date range |
| `label:` | `label:invoices`, `label:"to read"` | An App Feature — filtered off the Sync Backend's label join, **not** the Search Index |

Rules:

- **Implicit AND** between everything. No `OR`, no parentheses.
- **`-` negation on operators only** (`-in:junk`), not on free text.
- **Unknown `foo:` prefixes fall through to free text.** Nobody loses a search to a typo'd operator.
- **Quoted phrases are deferred** — a `"…"` phrase search is cheap in tsquery and a plausible later
  upgrade, but it is not PoC.

Boolean grammar is where a hand-rolled parser starts lying to the user, and the recovery gesture in
a mailbox is "type another word", not "restructure the boolean".

`label:` values need a stable typed form: the label name, double-quoted when it contains spaces.
Matching is case-insensitive on the name.

### The chip row

One line under the field, and the **only** place that states what this search covers. Left to right:

1. **Account chip** — rendered only when the User has more than one Mail Account.
2. **Scope chip** — `All mail` by default (all folders except Trash and Junk, per ADR-0016), or the
   seeded / typed folder or label.
3. **`Trash & Junk` toggle** — writes and removes `in:trash` / `in:junk`.
4. **Parsed operators** from what was typed, then the free-text remainder.

Every chip is driven off the **parse**, never off separate state. A chip the User didn't type renders
subdued as a default; typing `in:trash` lights the corresponding chip and flips the toggle. The row
doubles as the "interpreted as" display, so a mis-parse is visible rather than silent.

The Trash/Junk escape earns a toggle rather than a chip you must know to type: "I definitely deleted
it" is a top-five mail search and `in:trash` is not discoverable.

### Seeded scope

Opening search **seeds a scope chip from the view you launched from**, where — and only where — that
scope is expressible as a filter the User could have typed:

| Launched from | Seeds |
| --- | --- |
| Inbox | `in:inbox` |
| Archive, Sent, Drafts, a custom folder | `in:<folder>` |
| Trash / Junk | `in:trash` / `in:junk` (the seed *is* the escape from the default exclusion) |
| A Label view | `label:<name>` |
| Screener, Starred, Pinned, any saved view | nothing — `All mail` |

A seeded chip is **visibly inherited rather than typed**: it renders in a distinct style with a ✕,
and on first open carries the hint *"Searching Archive only — ⌫ to search all mail"*.

- **Backspace on an empty field pops the seed** (the tokenised-input gesture people already have in
  their fingers, unambiguous because the field is empty). So does the chip's ✕.
- `Esc` is **not** overloaded to clear the seed. A three-stage Esc does something different
  depending on state you have to look at the field to know, and its failure is silent: you meant to
  leave, you widened the search instead.
- **The seed is recomputed on every open.** Typed words survive leaving and returning; the scope is
  the app's inference about where you are standing, so standing somewhere new re-derives it. A stale
  `in:archive` carried into a search launched from the Inbox is the invisible-filter failure,
  delayed.
- **A manually typed or manually cleared scope wins over the seed** for as long as that query lives.
  Once the User has touched it, inference stops.

## The result list

**Ranked and ungrouped.** No time-grouping headers — the triage list's chronological grouping under
a relevance order is actively confusing, and "load older" already gives the list a coarse
chronological grain. Each row carries its own date.

No `Sort: Relevance / Newest` control at PoC: a `Newest` sort over a *relevance*-selected Candidate
Window is a subtly lying control.

### The row

Built on ADR-0011's `Thread` list-row projection, which search reuses unchanged, plus:

- **The `ts_headline` fragment replaces the Snippet**, with match terms emphasised — the row has to
  say *why* it matched. A subject-only match keeps its Snippet, so a row never looks broken.
- **A folder pill on every non-Inbox row** (`Archive`, `Sent`, `Trash`, a custom folder). Search
  crosses folders, and "where did this end up" is half the question. Inbox results get no pill; the
  default needs no label.
- **Gatekeeper badges only when the state is abnormal**: `Held` for mail in a Screening Hold,
  `Blocked` for mail its sender's Verdict sent to Trash. Both are findable per ADR-0016; unbadged, a
  held message reads as a delivery bug.
- **Opening a result lands on the matched message** in its thread — the matched message id travels
  with the row.

### Acting on a result

The standard triage set, via the same hover icons and right-click menu as any other list row. Per
ADR-0016, acting **materializes and pins the thread into the Local Cache** so ADR-0010's
`base ⊕ pending` overlay has a base, and the **row stays in place, visibly changed** — archiving
does not stop a message matching the query, and a vanishing row makes a result list feel like it is
eating mail.

**Gatekeeper Verdicts are not offered here.** They belong to the Screener, which is one decision per
stranger rather than one per message.

### The foot of the list: reaching further back

Both "results are bounded" affordances live at the **foot**, not in a top banner:

- **`Load older results`** — pages the Candidate Window back per ADR-0016 and appends. No totals, no
  page numbers, and **no infinite scroll**: auto-loading burns the query on a phone and makes
  ranking feel random.
- Directly beneath, **only while the body sweep is incomplete**, one muted line stating the
  **Index Watermark**: *"Bodies indexed back to March 2019 — older mail matches on sender and
  subject only."*

Foot rather than top, because a top banner charges attention on every search for a condition that
resolves itself once and never returns — and the moment the watermark matters is the moment you have
read the results and think something is missing, when your eye is already at the bottom.

The exception: on **zero results with an incomplete sweep**, the watermark line **promotes into the
empty state**, where it is the most likely explanation.

## Degraded states

**Empty.** "No matches", plus a restatement of how the query parsed, plus — when a filter is
plausibly the culprit — a one-click out (*"Search all folders"*, *"Remove From: vic"*). Plus the
promoted watermark line above.

**Offline.** The Local Cache prefilter *is* the result set: a persistent strip reads *"Offline —
searching recent mail only"*, and there is **no** Load-older button, because there is nothing to
load.

**`Needs Reauth`.** Treated as offline plus a call to action: the prefilter still serves from the
Local Cache, under a banner reading *"Reconnect &lt;account&gt; to search all mail"* with a reconnect
button and **no background retry loop**.

> This is a deliberate liberalisation of ADR-0016's wording, which says a `Needs Reauth` account's
> search is "unavailable with a banner and no retry loop". The no-retry-loop half stands. Returning
> nothing when a perfectly good Local Cache is sitting right there is strictly worse than returning
> what we have and saying so — which is the same contract offline already honours.

## Client prefilter

Restating ADR-0016's constraint because it is a UI-visible one: the Client runs a
**prefilter, not a second ranker** — case-insensitive substring over subject, sender name, sender
address and Snippet across the bounded Local Cache, date-ordered, **rendered identically to server
results** and replaced wholesale when they arrive (skipping the re-render when they agree).

The prefilter is what makes search feel local; it is not a fallback ranking, and it never claims
coverage it doesn't have.
