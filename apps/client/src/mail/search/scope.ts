/**
 * Seeded scope (#51, `docs/search-ux-spec.md` §Seeded scope): "opening
 * search seeds a scope chip from the view you launched from, where — and
 * only where — that scope is expressible as a filter the User could have
 * typed." The seed is a value, not a fact recorded in the query string
 * (spec: "a seeded chip is visibly inherited rather than typed") — it lives
 * beside the parsed query and is overridden the instant the User types or
 * clears an explicit `in:`/`label:` operator.
 *
 * This app has shipped exactly two navigable origins so far — the Inbox and
 * a Label view (`MailSection.tsx`'s `labelFilter`) — everything else the
 * spec's seed table names (Archive, Sent, Drafts, a custom folder, Trash,
 * Junk, Screener, Starred, Pinned) is a future view with nowhere in
 * `MailSection` to originate from yet. `ViewOrigin` still models the whole
 * table so the mapping is complete and future views only ever need to
 * construct the right variant, never touch this function again.
 */

export type ViewOrigin =
  | { kind: "inbox" }
  | { kind: "folder"; folder: string }
  | { kind: "trash" }
  | { kind: "junk" }
  | { kind: "label"; name: string }
  /** Screener, Starred, Pinned, any saved view (spec): seeds nothing — "All mail". */
  | { kind: "other" };

export type SeededScope =
  | { kind: "folder"; folder: string }
  | { kind: "label"; name: string }
  | null;

export function seedScopeFromOrigin(origin: ViewOrigin): SeededScope {
  switch (origin.kind) {
    case "inbox":
      return { kind: "folder", folder: "inbox" };
    case "folder":
      return { kind: "folder", folder: origin.folder };
    case "trash":
      return { kind: "folder", folder: "trash" };
    case "junk":
      return { kind: "folder", folder: "junk" };
    case "label":
      return { kind: "label", name: origin.name };
    case "other":
      return null;
  }
}

const FOLDER_LABELS: Record<string, string> = {
  inbox: "Inbox",
  archive: "Archive",
  sent: "Sent",
  drafts: "Drafts",
  trash: "Trash",
  junk: "Junk",
};

/** How a folder role (or a custom folder's exact name) reads in a chip — `docs/search-ux-spec.md`'s "Archive", "Sent", ... */
export function formatFolderLabel(folder: string): string {
  return FOLDER_LABELS[folder.toLowerCase()] ?? folder;
}

export function formatScopeLabel(
  scope: SeededScope | { kind: "folder"; folder: string } | { kind: "label"; name: string },
): string {
  if (!scope) return "All mail";
  return scope.kind === "folder"
    ? formatFolderLabel(scope.folder)
    : scope.kind === "label"
      ? scope.name
      : "All mail";
}

/** The first-open hint (spec): "Searching Archive only — ⌫ to search all mail." */
export function seededScopeHint(scope: SeededScope): string | null {
  if (!scope) return null;
  return `Searching ${formatScopeLabel(scope)} only — ⌫ to search all mail`;
}
