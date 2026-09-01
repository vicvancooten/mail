import type { ComposeDocument, ComposeNode, MailAccount, Message, Recipient } from "@mail/shared";
import type { ComposeContent } from "../store/compositions.js";
import { signatureDocumentNode } from "./mail-signature-extension.js";

/**
 * Reply / reply-all / forward (#47, compose-spec §Reply, reply-all,
 * forward, §Threading headers, §Signature): pure builders over "the
 * specific message the User had open" — never a network call, so opening a
 * reply is instant and works offline (ADR-0014), the same posture
 * `compose/recipients.ts`/`compose/send-validation.ts` already keep.
 */

export type ReplyMode = "reply" | "replyAll" | "forward";

/** How many ancestor ids either end of a truncated `References` keeps (compose-spec: "the first and the last ~20"). */
const REFERENCES_KEEP_EACH_END = 20;

/**
 * `References` truncated against the 998-octet header limit by keeping the
 * first and the last ~20, dropping the middle (compose-spec §Threading
 * headers): the root is what threads the reply into the conversation at
 * all, the tail is what threads it in locally. A chain shorter than
 * `2 * REFERENCES_KEEP_EACH_END` never needs trimming.
 */
export function truncateReferences(chain: string[]): string[] {
  if (chain.length <= REFERENCES_KEEP_EACH_END * 2) return chain;
  return [
    ...chain.slice(0, REFERENCES_KEEP_EACH_END),
    ...chain.slice(chain.length - REFERENCES_KEEP_EACH_END),
  ];
}

export interface ThreadingHeaders {
  inReplyTo: string | null;
  references: string[];
}

/**
 * `In-Reply-To` = the open message's own `Message-ID`; `References` = its
 * own `References` chain plus its `Message-ID` (compose-spec). A message
 * with no `Message-ID` of its own (malformed or missing on arrival) cannot
 * be threaded against — both come back empty rather than guessing.
 */
export function buildThreadingHeaders(message: Message): ThreadingHeaders {
  if (!message.messageIdHeader) return { inReplyTo: null, references: [] };
  return {
    inReplyTo: message.messageIdHeader,
    references: truncateReferences([...message.references, message.messageIdHeader]),
  };
}

/**
 * `Re: ` / `Fwd: `, only when not already present — never stacked
 * (compose-spec §Threading headers). "Already present" is recognized
 * whether or not the other client that wrote it put a space after the
 * colon (`"RE:hello"`, common from clients other than this one, is just as
 * prefixed as `"RE: hello"`) — the label must still be followed by a `:` or
 * the end of the subject, so `"Reply"` is never mistaken for an existing
 * `Re` prefix.
 */
export function buildSubject(originalSubject: string, mode: ReplyMode): string {
  const label = mode === "forward" ? "Fwd" : "Re";
  const prefix = `${label}: `;
  const already = new RegExp(`^${label}(:|$)\\s*`, "i").test(originalSubject);
  return already ? originalSubject : `${prefix}${originalSubject}`;
}

function normalizedAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Deduplicates on normalized address, keeping the best display name seen
 * (compose-spec §Recipients) — the first non-null name wins; a later bare
 * address for an already-named entry never blanks it out.
 */
function dedupeRecipients(recipients: Recipient[]): Recipient[] {
  const byAddress = new Map<string, Recipient>();
  for (const recipient of recipients) {
    const key = normalizedAddress(recipient.address);
    const existing = byAddress.get(key);
    if (!existing) {
      byAddress.set(key, recipient);
    } else if (!existing.name && recipient.name) {
      byAddress.set(key, { ...existing, name: recipient.name });
    }
  }
  return [...byAddress.values()];
}

function without(recipients: Recipient[], excluded: Set<string>): Recipient[] {
  return recipients.filter((recipient) => !excluded.has(normalizedAddress(recipient.address)));
}

export interface ReplyRecipients {
  to: Recipient[];
  cc: Recipient[];
}

/**
 * Reply: `To` = the original's `Reply-To` if present, else `From`.
 * Reply-all: that, plus the original `To` and `Cc` (moved to `Cc` on the new
 * message — the primary `To` stays the one addressee, matching what every
 * mainstream client does), minus the sending Mail Account's own address,
 * deduplicated (compose-spec §Recipients). Forward starts empty — the User
 * picks new recipients.
 */
export function buildReplyRecipients(
  mode: ReplyMode,
  message: Message,
  account: MailAccount,
): ReplyRecipients {
  if (mode === "forward") return { to: [], cc: [] };

  const primary = message.replyTo.length > 0 ? message.replyTo : message.from ? [message.from] : [];
  const to = dedupeRecipients(primary);
  if (mode === "reply") return { to, cc: [] };

  const self = new Set([normalizedAddress(account.emailAddress)]);
  const toAddresses = new Set(to.map((recipient) => normalizedAddress(recipient.address)));
  const cc = without(
    dedupeRecipients([...message.to, ...message.cc]),
    new Set([...self, ...toAddresses]),
  );
  return { to: without(to, self), cc };
}

function attributionLine(message: Message): ComposeNode {
  const name = message.from?.name ?? message.from?.address ?? "someone";
  const address = message.from?.address ? ` <${message.from.address}>` : "";
  const when = new Date(message.sentAt).toLocaleString();
  return {
    type: "paragraph",
    content: [{ type: "text", text: `On ${when}, ${name}${address} wrote:` }],
  };
}

function forwardHeaderBlock(message: Message): ComposeNode[] {
  const from = message.from
    ? `${message.from.name ?? message.from.address} <${message.from.address}>`
    : "(unknown sender)";
  const to = message.to.map((recipient) => recipient.name ?? recipient.address).join(", ");
  const line = (text: string): ComposeNode => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  });
  return [
    line("---------- Forwarded message ---------"),
    line(`From: ${from}`),
    line(`Date: ${new Date(message.sentAt).toLocaleString()}`),
    line(`Subject: ${message.subject}`),
    ...(to.length > 0 ? [line(`To: ${to}`)] : []),
  ];
}

/**
 * The composer's initial document for a reply/forward (compose-spec
 * §Signature, §Quoted original): the signature above the quote — "top-
 * posting; no settings toggle at PoC" — an empty paragraph for the cursor,
 * the attribution/forwarded-header block, and the Quoted Original itself as
 * one opaque `mailQuote` node holding `message.bodyHtml` **exactly** as it
 * arrived (ADR-0013). A message with no HTML alternative quotes its
 * plaintext, escaped into a single preformatted line — still opaque, still
 * verbatim.
 */
export function buildReplyDocument(
  mode: ReplyMode,
  message: Message,
  signature: string | null,
): ComposeDocument {
  const quotedHtml = message.bodyHtml ?? `<pre>${escapeForQuote(message.bodyText ?? "")}</pre>`;
  const headerBlock = mode === "forward" ? forwardHeaderBlock(message) : [attributionLine(message)];

  const content: ComposeNode[] = [
    ...(signature && signature.trim().length > 0 ? [signatureDocumentNode(signature)] : []),
    { type: "paragraph" },
    ...headerBlock,
    { type: "mailQuote", attrs: { html: quotedHtml } },
  ];

  return { type: "doc", content };
}

function escapeForQuote(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Everything `saveComposition` needs to seed a freshly-minted reply/forward Composition, in one call. */
export function buildReplyContent(
  mode: ReplyMode,
  message: Message,
  account: MailAccount,
): ComposeContent {
  const { to, cc } = buildReplyRecipients(mode, message, account);
  // Forwarding starts a new thread of its own recipients, not this one
  // (compose-spec §Threading headers only describes a *reply*'s headers).
  const { inReplyTo, references } =
    mode === "forward" ? { inReplyTo: null, references: [] } : buildThreadingHeaders(message);
  return {
    subject: buildSubject(message.subject, mode),
    document: buildReplyDocument(mode, message, account.signature),
    to,
    cc,
    bcc: [],
    inReplyTo,
    references,
  };
}
