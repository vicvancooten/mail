import { z } from "zod";

/**
 * Gatekeeper v1 (#55, CONTEXT.md §Gatekeeper, poc-spec.md §Gatekeeper v1,
 * ADR-0008): the screening feature's shared vocabulary — how a sender is
 * keyed, what a Verdict can be, and which domains are barred from ever
 * carrying one.
 *
 * Everything here is pure and account-agnostic on purpose. A Verdict is
 * always scoped to one Mail Account (CONTEXT.md: "Verdicts are scoped to a
 * single Mail Account, so they never cross Users or a User's other
 * accounts") — that scoping lives in the id derivation and the table's
 * `mail_account_id`, never in a rule this module could get wrong.
 */

/**
 * A sender address as Gatekeeper keys it: trimmed and lowercased, and
 * **deliberately not plus-tag-stripped** (poc-spec.md: "keyed to a
 * normalized `From` address (no plus-tag stripping)"). `a+news@x.com` and
 * `a@x.com` are different senders as far as screening is concerned, because
 * a plus tag is exactly how a User hands one address to one correspondent —
 * collapsing them would make approving a newsletter approve the person.
 */
export function normalizeSenderAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * The domain half of an address, normalized the same way. `null` for
 * anything without a single usable `@` — a `From` this malformed identifies
 * nobody, and guessing a domain from it would attach a Verdict to the wrong
 * sender.
 */
export function senderDomain(address: string): string | null {
  const normalized = normalizeSenderAddress(address);
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return null;
  return normalized.slice(at + 1);
}

/**
 * Domains a **domain** Verdict may never be written for (poc-spec.md:
 * "domain verdicts as an overflow convenience ... public providers barred").
 * Approving `gmail.com` approves a billion strangers and blocking it blocks
 * everyone the User actually knows there — in both directions the verdict
 * says nothing about the sender, which is the whole point of a domain rule.
 *
 * Not a spam-reputation list and not exhaustive: it only has to cover the
 * consumer providers a real mailbox meets often enough that the overflow
 * button would otherwise be a trap. Address verdicts stay available for
 * every one of these.
 */
export const BARRED_VERDICT_DOMAINS: readonly string[] = [
  "aol.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.co.uk",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "live.nl",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "yahoo.co.uk",
  "yahoo.com",
  "ymail.com",
  "zoho.com",
];

const BARRED = new Set(BARRED_VERDICT_DOMAINS);

/** Whether a domain Verdict is barred for this domain — see `BARRED_VERDICT_DOMAINS`. */
export function isBarredVerdictDomain(domain: string): boolean {
  return BARRED.has(domain.trim().toLowerCase());
}

/**
 * Where a sender stands with Gatekeeper on one Mail Account (CONTEXT.md).
 * `unscreened` is the **absence** of a stored Verdict, never a stored value:
 * a sender the User has not decided on and a sender whose Verdict was
 * cleared (Reset, unblock) are the same state, and modelling it as a row
 * would give the two different behaviour for no reason.
 */
export const gatekeeperVerdictSchema = z.enum(["unscreened", "approved", "blocked"]);
export type GatekeeperVerdict = z.infer<typeof gatekeeperVerdictSchema>;

/** A stored Verdict's granularity. `address` always wins over `domain` — see `resolveVerdict` in the Sync Backend. */
export const gatekeeperScopeSchema = z.enum(["address", "domain"]);
export type GatekeeperScope = z.infer<typeof gatekeeperScopeSchema>;

/**
 * Who wrote a Verdict, recorded on every one alongside its timestamp
 * (poc-spec.md: "source + timestamp recorded on every verdict"). This is
 * what makes "why is this sender approved?" answerable a year later —
 * `seed` is enabling's sweep of Sent history, `sent` is a live send,
 * `screener` is a decision the User made in the Screener, `settings` is the
 * Blocked Senders list.
 */
export const gatekeeperVerdictSourceSchema = z.enum(["seed", "sent", "screener", "settings"]);
export type GatekeeperVerdictSource = z.infer<typeof gatekeeperVerdictSourceSchema>;

/** What a Verdict is keyed to: one address, or a whole domain. */
export const gatekeeperSenderSchema = z.object({
  scope: gatekeeperScopeSchema,
  /** An address for `address` scope, a bare domain for `domain` scope — normalized by `normalizeGatekeeperSender`. */
  value: z.string().trim().min(1),
});
export type GatekeeperSender = z.infer<typeof gatekeeperSenderSchema>;

/** Normalizes a sender key the same way both sides of the wire must, so an id derived on either agrees. */
export function normalizeGatekeeperSender(sender: GatekeeperSender): GatekeeperSender {
  return { scope: sender.scope, value: normalizeSenderAddress(sender.value) };
}

/**
 * A Verdict's id: deterministic from `(mailAccountId, scope, value)` rather
 * than minted, the same "both sides derive it independently" shape
 * `labelId`/`correspondentId` already have — and, as with those, the Mail
 * Account is *in* the id, so two accounts' verdicts about the same address
 * can never collide into one row.
 */
export function gatekeeperVerdictId(
  mailAccountId: string,
  scope: GatekeeperScope,
  value: string,
): string {
  return `${mailAccountId}:${scope}:${normalizeSenderAddress(value)}`;
}

/**
 * A Mail Account's Gatekeeper settings, riding the `MailAccount` collection
 * alongside `signature`/`notificationsEnabled` (#54's precedent) rather than
 * as a collection of their own: one Mail Account, one row, and every Client
 * needs both fields wherever it renders the Screener at all.
 *
 * `cutoff` is the Gatekeeper Cutoff (CONTEXT.md) — the instant Gatekeeper
 * was switched on. Only mail arriving after it is ever screened; everything
 * already in the mailbox is grandfathered. Null while Gatekeeper has never
 * been enabled for this account; **kept** across a disable so re-enabling
 * without a Reset does not re-screen the gap.
 */
export const gatekeeperSettingsSchema = z.object({
  enabled: z.boolean(),
  cutoff: z.iso.datetime().nullable(),
});
export type GatekeeperSettings = z.infer<typeof gatekeeperSettingsSchema>;

/**
 * One row of the Blocked Senders list (poc-spec.md: "a Blocked Senders list
 * handles unblocking"). Read through `GET /mail-accounts/:id/gatekeeper`
 * rather than synced: the list is small, only Settings renders it, and it
 * has no optimistic-overlay story worth a collection.
 */
export const blockedSenderSchema = z.object({
  scope: gatekeeperScopeSchema,
  value: z.string(),
  source: gatekeeperVerdictSourceSchema,
  decidedAt: z.iso.datetime(),
  /**
   * Spam (CONTEXT.md, ADR-0008 amendment): a Block that additionally moves
   * held and future mail to the Mail Account's Junk folder instead of Trash,
   * so the provider's own filter learns. Recorded alongside `blocked` rather
   * than as a fourth Verdict value — Spam *is* a Block for every purpose a
   * `GatekeeperVerdict` answers (resolution, image-loading permission),
   * this flag is only ever consulted to pick Trash vs. Junk as the
   * destination.
   */
  spam: z.boolean(),
});
export type BlockedSender = z.infer<typeof blockedSenderSchema>;

/**
 * `GET /mail-accounts/:id/gatekeeper`. `approvedCount` is what makes the
 * seed legible after enabling ("2,431 senders approved from your Sent
 * history") — a bare count, never the list, which for a real mailbox is
 * thousands of rows nothing renders.
 */
export const gatekeeperStatusResponseSchema = z.object({
  gatekeeper: gatekeeperSettingsSchema,
  approvedCount: z.int(),
  blocked: z.array(blockedSenderSchema),
});
export type GatekeeperStatusResponse = z.infer<typeof gatekeeperStatusResponseSchema>;

/**
 * `POST /mail-accounts/:id/gatekeeper/enable` and its `reset` sibling both
 * answer with the fresh status plus how many senders the seed just
 * approved — the same shape a plain `GET` returns, so a Client never has to
 * follow one with the other.
 */
export const gatekeeperMutationResponseSchema = gatekeeperStatusResponseSchema.extend({
  /** How many Verdicts the seed wrote this call. Zero for `disable`. */
  seeded: z.int(),
});
export type GatekeeperMutationResponse = z.infer<typeof gatekeeperMutationResponseSchema>;
