import { useCallback } from "react";
import { StreamStack } from "../mail/stream/StreamStack.js";
import { streamRoute } from "./routes.js";

/**
 * `/mail/stream`'s route component (#105) — the same thin-glue shape
 * `MailRoute.tsx` gives `MailSection`: `StreamStack` itself stays
 * router-agnostic (every one of its own tests renders it bare), and this is
 * the one place that knows leaving Stream means navigating back to `/mail`.
 * A real route, not a modal or a search-style overlay (ADR-0017's own
 * "Stream is a destination, unlike search" test) — reloading `/mail/stream`
 * lands back in Stream rather than bouncing to Mail.
 */
export function StreamRoute() {
  const navigate = streamRoute.useNavigate();
  const onLeave = useCallback(() => {
    void navigate({ to: "/mail" });
  }, [navigate]);

  return <StreamStack onLeave={onLeave} />;
}
