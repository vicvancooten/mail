import type { Correspondent, Recipient } from "@mail/shared";
import { isSyntacticallyValidAddress, normalizeCorrespondentAddress } from "@mail/shared";

/**
 * Recipient field parsing (compose-spec §Recipients): "pasting into a
 * recipient field splits on comma / semicolon / newline and parses
 * `Name <addr>`, chipping each." Address validation is **syntactic only** —
 * no MX probe, no SMTP callout (compose-spec: "the send is the
 * verification and the bounce is the answer") — and lives in `@mail/shared`
 * (`isSyntacticallyValidAddress`, re-exported below) so the Sync Backend's
 * own send-time re-check can never disagree with this field about what
 * counts as a recipient.
 */

const NAME_ADDRESS = /^(.*)<([^<>]+)>$/;

export { isSyntacticallyValidAddress };

export function parseRecipients(input: string): Recipient[] {
  return input
    .split(/[,;\n]+/)
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map(parseOneRecipient);
}

function parseOneRecipient(raw: string): Recipient {
  const match = raw.match(NAME_ADDRESS);
  if (match) {
    const name = (match[1] ?? "").trim().replace(/^"(.*)"$/, "$1");
    const address = (match[2] ?? "").trim();
    return { name: name.length > 0 ? name : null, address };
  }
  return { name: null, address: raw };
}

/** How a chip renders: the display name if one is known, else the bare address. */
export function recipientLabel(recipient: Recipient): string {
  return recipient.name ?? recipient.address;
}

/** How a suggestion row renders: "Name <address>" when a name is known, else the bare address. */
export function correspondentLabel(correspondent: Correspondent): string {
  return correspondent.name
    ? `${correspondent.name} <${correspondent.address}>`
    : correspondent.address;
}

/**
 * Recipient autocomplete's matcher (#49, compose-spec §Recipient
 * autocomplete): a plain in-memory substring filter over an already-loaded,
 * already-ranked (score-descending) Correspondent list — never a re-sort,
 * never a second index. `correspondents` is expected pre-sorted by score
 * (`store/reads.ts#readCorrespondents`), so this only has to filter and
 * truncate, which is what keeps a keystroke's suggestions inside the <50ms
 * budget: no work here scales with the account's mail history, only with
 * the synced top ~500.
 */
export function matchCorrespondents(
  correspondents: Correspondent[],
  query: string,
  options: { exclude?: Set<string>; limit?: number } = {},
): Correspondent[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const exclude = options.exclude ?? new Set<string>();
  const limit = options.limit ?? 6;

  const matches: Correspondent[] = [];
  for (const correspondent of correspondents) {
    if (matches.length >= limit) break;
    if (exclude.has(normalizeCorrespondentAddress(correspondent.address))) continue;
    const haystack = `${correspondent.name ?? ""} ${correspondent.address}`.toLowerCase();
    if (haystack.includes(needle)) matches.push(correspondent);
  }
  return matches;
}
