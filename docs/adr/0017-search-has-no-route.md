# Search has no route

The Client gets a real router in #71 (TanStack Router, part of #66): Mail, the three placeholder
Apps, and Settings all get URLs, so a reload or a bookmark restores the view. Search deliberately
gets none of this. Where every other screen moved from ad hoc component state onto a route, search
moves the other way — off the hand-rolled `/search?q=` route it had (`history.pushState`/
`popstate`, from before this Client had a router at all) onto plain, routeless component state
(`mail/search/useSearchOverlay.ts`).

## What this gives up

- **No shareable search link.** `/search?q=invoice` was never truly shareable in the first place —
  it carries no Mail Account, and a second User signed in to a different account would land on a
  query scoped to whichever account happened to be current for them — but it did survive a reload
  or a paste into a new tab for the same User on the same device. That's gone: reloading mid-search
  now lands back on whichever screen search was opened over, with the query cleared.
- **No back-button history across searches.** The old route pushed a checkpoint entry on commit (an
  Enter or a blur), so Back walked committed searches one at a time before leaving. That mechanism
  is gone with the route; leaving search is now just closing the overlay, one step, regardless of
  how many queries were run first.

Both are real losses, and both were already unusual for what search actually is here: a working
surface layered over whichever screen the User was on, not a destination a User "goes to" or wants
to return to days later from a link. Search-ux-spec.md's own framing — "one list renderer, search is
another list, not a second application" — was already describing an overlay; the route was an
implementation detail of a Client that had no other way to make `/` and `⌘K` feel like "this opened
a surface" without one.

## Why now, with a router in hand

Two things make giving up the route an easy call rather than a compromise, now that #71 exists to
compare against:

- **Every other screen's URL is a restorable snapshot of "where you are", not a history of "what you
  did there".** Mail's own route (`/mail?label=&thread=`) is written with `replace`, never `push` —
  selecting a Thread or switching a Label filter never grows a history entry. Search staying off the
  router entirely, rather than joining it as a route that behaves like every other one, is the same
  choice made once instead of per-navigation: nothing about *searching* should grow history any more
  than *reading* does.
- **A hand-rolled route was already fighting the shape a real router gives everything else for
  free**, and worse now that one exists next to it: `useSearchRoute.ts` maintained its own
  `pushState`/`replaceState`/`popstate` bookkeeping (`pushedOwnEntryRef`, `enteredRef`) to approximate
  exactly the "replace while typing, checkpoint on commit" behavior TanStack Router would have given
  for free — and doing so as a second, parallel navigation mechanism a Router now already owns.
  Keeping it as a route would mean either duplicating the router's real machinery for one screen or
  registering `/search` as an actual route whose only behavior (`?q=`, checkpoints) exists nowhere
  else in the app.

## What replaced it

`useSearchOverlay.ts`: two pieces of `useState` (`active`, `query`) and the same five-method surface
(`open`, `updateQuery`, `commitQuery`, `leave`) the route used to expose, so `useSearchState.ts` —
which owns the parse, the prefilter, and the `POST /search` round trip — didn't have to change at
all beyond the rename. `updateQuery` and `commitQuery` now do the same thing (there is no checkpoint
left to distinguish them); the method stays split in two so a future reason to tell "typing" from
"committing" apart doesn't require touching every caller again.
