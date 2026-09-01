import type { Recipient } from "@mail/shared";

/**
 * Recipient field parsing (compose-spec §Recipients): "pasting into a
 * recipient field splits on comma / semicolon / newline and parses
 * `Name <addr>`, chipping each." Address validation is **syntactic only** —
 * no MX probe, no SMTP callout (compose-spec: "the send is the
 * verification and the bounce is the answer").
 */

const NAME_ADDRESS = /^(.*)<([^<>]+)>$/;
/** Deliberately loose — just "looks like an address", not an RFC 5322 parser. */
const SYNTACTICALLY_VALID_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export function isSyntacticallyValidAddress(address: string): boolean {
  return SYNTACTICALLY_VALID_ADDRESS.test(address);
}

/** How a chip renders: the display name if one is known, else the bare address. */
export function recipientLabel(recipient: Recipient): string {
  return recipient.name ?? recipient.address;
}
