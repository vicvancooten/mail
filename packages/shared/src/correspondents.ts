/**
 * Deterministic Correspondent identity (#49, CONTEXT.md's Correspondent,
 * compose-spec §Recipient autocomplete). A Correspondent's id is derived
 * from its Mail Account and normalized address rather than minted
 * server-side, the same "offline-derivable, both sides agree independently"
 * shape `labels.ts#labelId` is for a Label — nothing here ever hands an id
 * back across the wire for the other side to remember.
 */

/** Case-insensitive, trimmed: `Vic@Example.com` and `vic@example.com ` are the same Correspondent. */
export function normalizeCorrespondentAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** A Correspondent's id: stable, and scoped to its Mail Account (two accounts' contact with the same address are different Correspondents — CONTEXT.md's Mail Account scoping instinct). */
export function correspondentId(mailAccountId: string, address: string): string {
  return `${mailAccountId}:${normalizeCorrespondentAddress(address)}`;
}
