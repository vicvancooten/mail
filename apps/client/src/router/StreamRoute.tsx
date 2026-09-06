import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { StreamStack } from "../mail/stream/StreamStack.js";
import { streamRoute } from "./routes.js";

/**
 * `/mail/stream`'s route component (#105) — the same thin-glue shape
 * `MailRoute.tsx` gives `MailSection`: `StreamStack` itself stays
 * router-agnostic (every one of its own tests renders it bare), and this is
 * the one place that knows what leaving Stream means. A real route, not a
 * modal or a search-style overlay (ADR-0017's own "Stream is a destination,
 * unlike search" test) — reloading `/mail/stream` lands back in Stream
 * rather than bouncing to Mail.
 *
 * #141 (#133's Navigation decisions): entering Stream is always a push
 * (`Sidebar.tsx`'s `onOpenStream` navigate, unchanged), so leaving it should
 * be the mirror — go *back* through history to whatever pushed it, the same
 * "one Back always returns you" shape #140 gave the Reader, rather than a
 * second `navigate({ to: "/mail" })` that piles a fresh entry on top and
 * leaves the one Stream itself arrived on behind as a ghost.
 *
 * `router.history.canGoBack()` (`__TSR_index !== 0`, `@tanstack/history`)
 * is the test for "entered from within the app" — it's already exactly
 * #140's `readerEntryIsTopRef` idea, just read off the history stack
 * instead of tracked by hand, since here there's no in-Reader replace
 * traffic to confuse a hand-kept ref the way `MailRoute.tsx`'s doc comment
 * describes. Only a cold load — `/mail/stream` typed, bookmarked, or
 * reloaded with nothing pushed before it in this browsing session — reads
 * `false`, and only then does leaving fall back to a `replace` navigate to
 * Mail (a `replace`, not a push: there is nothing to go back to, so this
 * becomes the whole stack rather than growing it).
 */
export function StreamRoute() {
  const navigate = streamRoute.useNavigate();
  const router = useRouter();
  const onLeave = useCallback(() => {
    if (router.history.canGoBack()) {
      router.history.back();
    } else {
      void navigate({ to: "/mail", replace: true });
    }
  }, [navigate, router]);

  return <StreamStack onLeave={onLeave} />;
}
