# ios-sse-probe

Minimal, dependency-free harness for wayfinder ticket
[Empirically verify iOS backgrounded-PWA SSE connection lifetime](https://github.com/vicvancooten/mail/issues/28).

Not part of the Mail PoC — a throwaway diagnostic tool, kept only until #28 closes.

## What it is

A one-page installable PWA that opens an `EventSource` against `/events` and logs, on-screen,
every heartbeat (server sends one every 25s, matching [ADR-0015](https://github.com/vicvancooten/mail/blob/main/docs/adr/0015-realtime-is-sse-hints-plus-web-push.md)'s assumed cadence) plus every
lifecycle event (`visibilitychange`, `pagehide`/`pageshow`, `freeze`/`resume`, EventSource
open/error). The log persists to `localStorage` so it survives iOS reloading the page after
backgrounding — that reload is itself one of the things we're trying to observe.

## Run it

```sh
cd apps/ios-sse-probe
pnpm install   # or: npm install, from this directory
pnpm start     # listens on :8791
```

Then expose that port over **HTTPS reachable from your phone** — iOS's "Add to Home Screen"
standalone mode needs a trusted origin. Pick whichever of these you already have:

- **Tailscale Funnel**: `tailscale funnel 8791` (simplest if you're already on Tailscale)
- **cloudflared**: `cloudflared tunnel --url http://localhost:8791`
- **ngrok**: `ngrok http 8791`

## Checklist (the part only you can do)

1. Open the HTTPS URL in Safari on the iPhone. Confirm the status box shows the connection
   `OPEN` and a heartbeat arriving (readyState `OPEN`, "seconds since last heartbeat" ticking
   up to ~25 then resetting).
2. **Add to Home Screen** (Share → Add to Home Screen), then launch the app from the Home
   Screen icon (not the Safari tab) — standalone mode is what we're testing, not a Safari tab.
3. Confirm it's live again, then background it (Home button / swipe up, or lock the screen)
   **without force-quitting**, for each duration in turn: 10s, 30s, 2min, 10min. Between each,
   foreground it and check the status box / log:
   - Is `readyState` still `OPEN`, or did it flip to `CLOSED`/`CONNECTING`?
   - Did a `pagehide`/`pageshow` or `freeze`/`resume` fire? Did the session id change (a
     changed id means iOS reloaded the page from scratch, losing the in-memory EventSource
     entirely — the log persists across this, so you'll still see it)?
   - How many seconds since the last heartbeat when you foregrounded?
4. Watch what happens right after foregrounding: does a fresh `hello`/heartbeat arrive within
   a few seconds (EventSource's default auto-reconnect), or does it stall? Note roughly how
   long reconnection takes if it's not instant.
5. Use **Copy log** to grab the full timestamped log after each run (or read it off-screen) —
   paste it into the ticket resolution along with your observations.

Record the outcome (even an approximate threshold, e.g. "survives ~30s, dead by 2min") as the
ticket's answer. If it drops fast enough to matter in practice, flag — don't decide — whether a
backgrounded-but-open Client needs the same Web Push treatment as a fully closed one; that's a
follow-on decision, not this ticket's call.
