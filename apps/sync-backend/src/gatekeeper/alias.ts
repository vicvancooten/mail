import { normalizeSenderAddress, senderDomain } from "@mail/shared";
import type { MessageAddress } from "../db/schema.js";

/**
 * The Alias (#103, CONTEXT.md, ADR-0008's amendment) an arriving message
 * resolves to: "the recipient is read from `Delivered-To`/`X-Original-To`
 * first and `To`/`Cc` second, since spam to a catch-all usually arrives
 * Bcc'd." `Delivered-To`/`X-Original-To` are what an MDA actually stamps
 * with the envelope recipient a Bcc never names on the wire otherwise; the
 * visible `To`/`Cc` list is only trusted as a fallback for a server that
 * stamps neither.
 *
 * The two tiers are trusted differently, on purpose. `Delivered-To`/
 * `X-Original-To` are accepted outright, at *any* domain: the ticket's own
 * case is a catch-all domain the User hands out per-correspondent
 * (`somecompany@theirdomain`) that has no reason to share a domain with the
 * Mail Account's own login address — an MDA only ever stamps the envelope
 * recipient that caused *this* mailbox to receive the message, so the
 * header is already "this arrived at me", regardless of what domain it
 * names. `To`/`Cc`, by contrast, is genuinely weak evidence — a co-recipient
 * of a message sent to several people, or a mailing list's own address,
 * sits there with no MDA behind it vouching for it — so that fallback still
 * requires a match against the one domain this module can actually check,
 * `senderDomain(mailAccountEmailAddress)`: treating a stranger's address in
 * `To`/`Cc` as the User's own Alias is the real hazard, and the domain gate
 * is what stops it. (An earlier revision held every candidate, headers
 * included, to that same gate — which defeated the ticket's whole use case
 * whenever the catch-all domain wasn't the login domain, #90's review.)
 *
 * `sync/ingest.ts#storeMessage` is the only caller — this module is
 * otherwise pure and knows nothing about the database.
 */
export function resolveRecipientAlias(input: {
  mailAccountEmailAddress: string;
  headerBlock: Buffer | undefined;
  toAddresses: readonly MessageAddress[];
  ccAddresses: readonly MessageAddress[];
}): string | null {
  const headerCandidates = [
    extractHeaderAddress(input.headerBlock, "delivered-to"),
    extractHeaderAddress(input.headerBlock, "x-original-to"),
  ];
  for (const candidate of headerCandidates) {
    if (!candidate) continue;
    const normalized = normalizeSenderAddress(candidate);
    // Still requires *a* parseable domain — a malformed stamp identifies no
    // Alias to block, the same "guessing from garbage" refusal
    // `senderDomain` itself gives every other caller.
    if (senderDomain(normalized)) return normalized;
  }

  const ownDomain = senderDomain(input.mailAccountEmailAddress);
  if (!ownDomain) return null;

  const toCcCandidates = [...input.toAddresses, ...input.ccAddresses].map(
    (address) => address.address,
  );
  for (const candidate of toCcCandidates) {
    if (!candidate) continue;
    const normalized = normalizeSenderAddress(candidate);
    if (senderDomain(normalized) === ownDomain) return normalized;
  }
  return null;
}

/**
 * Pulls one header's value out of the raw header block ImapFlow returns for
 * `fetch(..., { headers: [...] })` — the same small-RFC-5322-header-section
 * unfolding `sync/message-ids.ts#extractReferencesHeader` uses (a
 * continuation line starts with whitespace), generalized to any header name
 * and stripping the angle brackets a `Delivered-To`/`X-Original-To` value
 * sometimes carries. Returns the first line's value; these headers never
 * legitimately repeat the way `References` can.
 */
function extractHeaderAddress(headerBlock: Buffer | undefined, headerName: string): string | null {
  if (!headerBlock || headerBlock.length === 0) return null;
  const unfolded = headerBlock.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const pattern = new RegExp(`^${headerName}\\s*:(.*)$`, "i");
  for (const line of unfolded.split(/\r?\n/)) {
    const match = pattern.exec(line);
    const value = match?.[1]?.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
    if (value) return value;
  }
  return null;
}
