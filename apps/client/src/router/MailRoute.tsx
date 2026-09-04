import { useCallback, useRef } from "react";
import type { FolderKey } from "../mail/folders.js";
import { MailSection } from "../mail/MailSection.js";
import { mailRoute } from "./routes.js";

/**
 * `/mail`'s route component (#71): the one place that knows `MailSection`
 * lives at a route at all. `MailSection` itself stays router-agnostic (every
 * one of its own tests renders it bare, with no router present) — this just
 * seeds it from `?label=&folder=&thread=` on mount and mirrors every later
 * change back, the same "URL as a restorable snapshot, not a history of
 * every selection" shape `search-ux-spec.md`'s ADR-0017 describes for
 * search — with one exception (#81, mail#66's "Phone: reading pushes
 * full-screen with ... a working back gesture supplied by the router, the
 * way every other app on the phone behaves"): opening a Thread from no
 * selection is a real history entry, `replace: false`, so Back actually
 * returns to the list instead of leaving `/mail` altogether. Every other
 * change here — a folder/label switch, moving between Threads, closing the
 * pane — stays a `replace`, or reopening a Thread from the list on a device
 * with room to browse several in a row would spam history with one entry
 * per row clicked.
 */
export function MailRoute() {
  const search = mailRoute.useSearch();
  const navigate = mailRoute.useNavigate();
  // `undefined` here means "no Thread selected", the same meaning
  // `search.thread` itself carries — seeded from the URL a fresh mount
  // landed on, so a reload straight onto `/mail?thread=t1` never mistakes
  // its own first render for "just opened".
  const previousThreadRef = useRef(search.thread);

  const onLocationChange = useCallback(
    (location: { labelFilter: string | null; folder: FolderKey; threadId: string | null }) => {
      const opening = previousThreadRef.current === undefined && location.threadId !== null;
      previousThreadRef.current = location.threadId ?? undefined;
      void navigate({
        search: {
          label: location.labelFilter ?? undefined,
          folder: location.folder,
          thread: location.threadId ?? undefined,
        },
        replace: !opening,
      });
    },
    [navigate],
  );

  return (
    <MailSection
      initialLabelFilter={search.label ?? null}
      initialFolder={search.folder}
      initialThreadId={search.thread ?? null}
      onLocationChange={onLocationChange}
    />
  );
}
