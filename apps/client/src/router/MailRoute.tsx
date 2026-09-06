import { useRouter } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import type { FolderKey } from "../mail/folders.js";
import { type LocationChangeReason, MailSection } from "../mail/MailSection.js";
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
 *
 * #140 fixed two bugs in that scheme. First, `previousThreadRef` used to be
 * overwritten by every location change regardless of cause, including the
 * Back/Forward reconciliation `MailSection` does when the URL moves on its
 * own — so a Back closing the Reader reset it to "no selection", and a
 * later Forward back into the same Thread read as a *fresh* opening and
 * pushed a duplicate entry, leaving the next Back looking like it did
 * nothing. `MailSection`'s `LocationChangeReason` is the fix: only a
 * `"select"` (a genuine User-driven move) can ever push; a `"sync"` (the URL
 * itself changing, Back/Forward) only updates the marker. Second, closing
 * the Reader (the Back pill, `u`) used to always `replace` to a list URL,
 * leaving the entry the original open pushed behind as a ghost that Back
 * from the list had to walk through. `readerEntryIsTopRef` tracks whether
 * that pushed entry is still the top of the history stack — true from the
 * push until it's consumed — so a `"close"` can pop it with the router's
 * own `history.back()` instead.
 */
export function MailRoute() {
  const search = mailRoute.useSearch();
  const navigate = mailRoute.useNavigate();
  const router = useRouter();
  // `undefined` here means "no Thread selected", the same meaning
  // `search.thread` itself carries — seeded from the URL a fresh mount
  // landed on, so a reload straight onto `/mail?thread=t1` never mistakes
  // its own first render for "just opened".
  const previousThreadRef = useRef(search.thread);
  // Whether the Reader entry showing right now is still the one a `"select"`
  // push put on top of the history stack — set on that push, cleared once a
  // `"close"` consumes it (via `history.back()`) or a `"sync"` reports we've
  // moved off it (a Back moved to the list beneath it; landing back on a
  // Thread by any means puts us at the top again, since every in-Reader move
  // is a `replace` that never adds an entry to move off of). Reload straight
  // onto a Thread starts `false`: there is nothing pushed this session to
  // pop, so closing falls back to a plain `replace`.
  const readerEntryIsTopRef = useRef(false);

  const onLocationChange = useCallback(
    (
      location: { labelFilter: string | null; folder: FolderKey; threadId: string | null },
      reason: LocationChangeReason,
    ) => {
      const opening =
        reason === "select" &&
        previousThreadRef.current === undefined &&
        location.threadId !== null;
      previousThreadRef.current = location.threadId ?? undefined;

      if (reason === "sync") {
        readerEntryIsTopRef.current = location.threadId !== null;
        return; // The URL already reflects this; nothing to navigate.
      }

      if (reason === "close" && readerEntryIsTopRef.current) {
        readerEntryIsTopRef.current = false;
        router.history.back();
        return;
      }

      // A push always lands us on top; closing (any way but the pill/`u`,
      // e.g. a folder switch clearing the selection) always leaves it.
      // Moving between two open Threads (prev/next, Auto-advance) is a
      // `replace` at the same position, so it changes neither — leave
      // whatever `readerEntryIsTopRef` already said alone.
      if (opening) readerEntryIsTopRef.current = true;
      else if (location.threadId === null) readerEntryIsTopRef.current = false;
      void navigate({
        search: {
          label: location.labelFilter ?? undefined,
          folder: location.folder,
          thread: location.threadId ?? undefined,
        },
        replace: !opening,
      });
    },
    [navigate, router],
  );

  const onOpenStream = useCallback(() => {
    void navigate({ to: "/mail/stream" });
  }, [navigate]);

  return (
    <MailSection
      initialLabelFilter={search.label ?? null}
      initialFolder={search.folder}
      initialThreadId={search.thread ?? null}
      initialAccountId={search.account ?? null}
      onLocationChange={onLocationChange}
      onOpenStream={onOpenStream}
    />
  );
}
