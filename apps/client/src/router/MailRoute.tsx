import { useCallback } from "react";
import { MailSection } from "../mail/MailSection.js";
import { mailRoute } from "./routes.js";

/**
 * `/mail`'s route component (#71): the one place that knows `MailSection`
 * lives at a route at all. `MailSection` itself stays router-agnostic (every
 * one of its own tests renders it bare, with no router present) — this just
 * seeds it from `?label=&thread=` on mount and mirrors every later change
 * back with a `replace` navigation, the same "URL as a restorable snapshot,
 * not a history of every selection" shape `search-ux-spec.md`'s ADR-0017
 * describes for search, minus the "no route at all" part: Mail *does* get a
 * route, just one that never grows history entries of its own.
 */
export function MailRoute() {
  const search = mailRoute.useSearch();
  const navigate = mailRoute.useNavigate();

  const onLocationChange = useCallback(
    (location: { labelFilter: string | null; threadId: string | null }) => {
      void navigate({
        search: {
          label: location.labelFilter ?? undefined,
          thread: location.threadId ?? undefined,
        },
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <MailSection
      initialLabelFilter={search.label ?? null}
      initialThreadId={search.thread ?? null}
      onLocationChange={onLocationChange}
    />
  );
}
