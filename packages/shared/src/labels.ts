/**
 * Deterministic Label identity (#43, ADR-0011: "Labels sync as their own
 * collection"). A Label's id is derived from its Mail Account and name
 * rather than minted server-side and handed back to the Client, so a Client
 * can predict it the instant the User types a name — applying a brand-new
 * Label works fully offline, with no round trip needed before the
 * Optimistic Action's overlay has an id to reference (ADR-0010). Both
 * `apps/sync-backend` and `apps/client` import this one function so they
 * never disagree about what a given (Mail Account, name) pair's id is.
 */

/** Collapses incidental whitespace so "Work" and "  Work " are the same Label, not two rows. */
export function normalizeLabelName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export const LABEL_NAME_MAX_LENGTH = 64;

/** `""` (after trimming) and anything past the length cap are the only rejected shapes — no other restriction. */
export function isValidLabelName(name: string): boolean {
  const normalized = normalizeLabelName(name);
  return normalized.length > 0 && normalized.length <= LABEL_NAME_MAX_LENGTH;
}

/** A Label's id: stable, offline-derivable, and scoped to its Mail Account (two accounts' "Work" are different Labels). */
export function labelId(mailAccountId: string, name: string): string {
  return `${mailAccountId}:${normalizeLabelName(name)}`;
}

/**
 * The inverse of `labelId`: recovers a Label's display name straight from
 * its id, no `Label` collection row required. What lets the Client render a
 * Label chip on a Thread the instant an offline `applyLabel` overlay lands
 * (`store/reads.ts`) — before the synced `Label` row for a brand-new name
 * has ever arrived. Falls back to the id verbatim on a shape this Mail
 * Account's prefix doesn't match (defensive only; every id this codebase
 * produces does match).
 */
export function labelNameFromId(mailAccountId: string, id: string): string {
  const prefix = `${mailAccountId}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}
