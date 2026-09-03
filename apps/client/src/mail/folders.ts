import type { ViewKey } from "../store/index.js";

/**
 * The sidebar's folder destinations (#74), in the order the Sidebar renders
 * them. `label` is deliberately not one of these — Labels are an open-ended,
 * User-defined set (`store/reads.ts#useLabels`), rendered as their own
 * section under the fixed list rather than a fixed `FolderKey` each.
 * `screener` and `snoozed`/`drafts` don't feed `useThreadWindow` at all (see
 * `folderToView` below) — they're routes with a URL like every other entry
 * here (the ticket's own acceptance criterion), just not Thread-window
 * views.
 */
export type FolderKey =
  | "inbox"
  | "screener"
  | "snoozed"
  | "pinned"
  | "drafts"
  | "sent"
  | "archive"
  | "trash";

export const DEFAULT_FOLDER: FolderKey = "inbox";

/** Sidebar order (poc-spec.md's own list, Compose excluded — it opens the Composer, not a route). */
export const FOLDER_ORDER: readonly FolderKey[] = [
  "inbox",
  "screener",
  "snoozed",
  "pinned",
  "drafts",
  "sent",
  "archive",
  "trash",
];

export const FOLDER_LABELS: Record<FolderKey, string> = {
  inbox: "Inbox",
  screener: "Screener",
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
 * `screener`, `snoozed` and `drafts` render their own surface instead
 * (`MailSection.tsx`'s own body switch) and never call `useThreadWindow`
 * with this — the mapping here is only ever consulted for the five that do,
 * `all` is a harmless default for the rest so the hook itself can still be
 * called unconditionally (Rules of Hooks).
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
    default:
      return "all";
  }
}
