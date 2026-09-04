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
 * Every candidate is required to sit at the Mail Account's own domain
 * (`senderDomain(mailAccountEmailAddress)`) before it is accepted — an Alias
 * is "an address at a domain the User controls" (CONTEXT.md), so a
 * `Delivered-To` some intermediate relay stamped for an unrelated domain, or
 * a co-recipient's own address sitting in `To`/`Cc`, is noise this discards
 * rather than something to offer blocking. `sync/ingest.ts#storeMessage` is
 * the only caller — this module is otherwise pure and knows nothing about
 * the database.
 */
export function resolveRecipientAlias(input: {
  mailAccountEmailAddress: string;
  headerBlock: Buffer | undefined;
  toAddresses: readonly MessageAddress[];
  ccAddresses: readonly MessageAddress[];
}): string | null {
  const ownDomain = senderDomain(input.mailAccountEmailAddress);
  if (!ownDomain) return null;

  const candidates = [
    extractHeaderAddress(input.headerBlock, "delivered-to"),
    extractHeaderAddress(input.headerBlock, "x-original-to"),
    ...input.toAddresses.map((address) => address.address),
    ...input.ccAddresses.map((address) => address.address),
  ];

  for (const candidate of candidates) {
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
