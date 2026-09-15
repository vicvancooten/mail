import type { ViewKey } from "../store/index.js";

/**
 * The sidebar's folder destinations (#74), in the order the Sidebar renders
 * them. `label` is deliberately not one of these — Labels are an open-ended,
 * User-defined set (`store/reads.ts#useLabels`), rendered as their own
 * section under the fixed list rather than a fixed `FolderKey` each. The
 * Screener used to be one of these too, but it never lined up with the
 * others — the User never toggles *into* it the way they switch folders,
 * it's a queue entered deliberately (the Gatekeeper banner's own "Review",
 * the Command Palette) and left again — so it's a sibling route of its own
 * now (`router/routes.tsx#screenerRoute`, `router/ScreenerRoute.tsx`)
 * instead of a `FolderKey`, and dropped from the sidebar's fixed list
 * entirely: the banner already does the job a sidebar entry would. `drafts`
 * stays a `FolderKey` — it *is* one of the fixed destinations, it just
 * doesn't feed `useThreadWindow` (see `folderToView` below): its own surface
 * instead (`MailSection.tsx`'s own body switch). `snoozed` (#76) does feed
 * it — "the Snoozed folder view lists what is waiting" — `folderToView`
 * maps it to its own `ViewKey` rather than falling into the `all` default.
 */
export type FolderKey = "inbox" | "snoozed" | "pinned" | "drafts" | "sent" | "archive" | "trash";

export const DEFAULT_FOLDER: FolderKey = "inbox";

/** Sidebar order (poc-spec.md's own list, Compose excluded — it opens the Composer, not a route). */
export const FOLDER_ORDER: readonly FolderKey[] = [
  "inbox",
  "snoozed",
  "pinned",
  "drafts",
  "sent",
  "archive",
  "trash",
];

export const FOLDER_LABELS: Record<FolderKey, string> = {
  inbox: "Inbox",
  snoozed: "Snoozed",
  pinned: "Pinned",
  drafts: "Drafts",
  sent: "Sent",
  archive: "Archive",
  trash: "Trash",
};

/** Narrows an arbitrary string (a `?folder=` search param) to a known `FolderKey`, or `null`. */
export function parseFolderKey(value: string | undefined): FolderKey | null {
  return value !== undefined && (FOLDER_ORDER as readonly string[]).includes(value)
    ? (value as FolderKey)
    : null;
}

/**
 * Which `ViewKey` (`store/db.ts`) a `FolderKey` reads from `useThreadWindow`.
 * `drafts` renders its own surface instead (`MailSection.tsx`'s own body
 * switch) and never calls `useThreadWindow` with this — the mapping here is
 * only ever consulted for the five that do, `all` is a harmless default for
 * `drafts` so the hook itself can still be called unconditionally (Rules of
 * Hooks).
 */
export function folderToView(folder: FolderKey): ViewKey {
  switch (folder) {
    case "pinned":
      return "pinned";
    case "archive":
      return "archive";
    case "trash":
      return "trash";
    case "sent":
      return "sent";
    case "snoozed":
      return "snoozed";
    default:
      return "all";
  }
}
