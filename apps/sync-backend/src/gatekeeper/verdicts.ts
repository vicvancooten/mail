import type {
  BlockedSender,
  GatekeeperScope,
  GatekeeperVerdict,
  GatekeeperVerdictSource,
} from "@mail/shared";
import {
  gatekeeperVerdictId,
  isBarredVerdictDomain,
  normalizeSenderAddress,
  senderDomain,
} from "@mail/shared";
import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { folders, gatekeeperVerdicts, messages } from "../db/schema.js";
import { getMailAccountById } from "../mail-accounts/store.js";

/**
 * The Verdict store (#55, CONTEXT.md §Gatekeeper): reading where a sender
 * stands on one Mail Account, and every path that writes it.
 *
 * Three rules are enforced here and nowhere else, so no caller can get them
 * wrong:
 *
 * - **Address beats domain** (poc-spec.md). A `blocked` domain with an
 *   `approved` address inside it approves that one person, and vice versa —
 *   the narrower statement is always the more recent, more deliberate one.
 * - **Public providers are barred from domain verdicts**
 *   (`@mail/shared`'s `BARRED_VERDICT_DOMAINS`). Refused at write time, and
 *   ignored again at read time: a row that somehow exists — hand-inserted,
 *   or written before a domain joined the list — must not start approving a
 *   billion strangers.
 * - **A `recipient` (Alias) Verdict is always Blocked, and never the Mail
 *   Account's own primary address** (#103, CONTEXT.md's Blocked Alias). The
 *   first refusal is what makes "no Approved Alias" true regardless of what
 *   a caller passes; the second is the ticket's own "refuse when the Alias
 *   equals the Mail Account's primary address" — a User cannot silence their
 *   own inbox.
 *
 * Unscreened is the absence of a row (see `db/schema.ts`), so nothing here
 * ever *stores* `unscreened`; clearing a Verdict is a delete.
 */

/** One resolved sender: the Verdict, and which stored row produced it (`null` when Unscreened). */
export interface ResolvedVerdict {
  verdict: GatekeeperVerdict;
  scope: GatekeeperScope | null;
  /** Spam (#102): only ever `true` alongside `verdict: "blocked"` — see `blockedSenderSchema`'s doc comment (`@mail/shared`). */
  spam: boolean;
}

const UNSCREENED: ResolvedVerdict = { verdict: "unscreened", scope: null, spam: false };

/**
 * Resolves a batch of `From` addresses in one round trip — the shape every
 * real caller wants (a thread's messages, a page of search results, an
 * arriving delta batch), with `resolveVerdict` below as the single-address
 * convenience over it. Addresses are keyed in the returned map by their
 * *normalized* form; a caller holding the raw header value should normalize
 * before looking up, or use `verdictFor`.
 */
export async function resolveVerdicts(
  db: Db,
  mailAccountId: string,
  addresses: readonly string[],
): Promise<Map<string, ResolvedVerdict>> {
  const normalized = [...new Set(addresses.map(normalizeSenderAddress))].filter(
    (address) => address.length > 0,
  );
  const resolved = new Map<string, ResolvedVerdict>();
  if (normalized.length === 0) return resolved;

  const domains = [
    ...new Set(
      normalized
        .map(senderDomain)
        .filter((domain): domain is string => domain !== null && !isBarredVerdictDomain(domain)),
    ),
  ];

  const rows = await db
    .select({
      scope: gatekeeperVerdicts.scope,
      value: gatekeeperVerdicts.value,
      verdict: gatekeeperVerdicts.verdict,
      spam: gatekeeperVerdicts.spam,
    })
    .from(gatekeeperVerdicts)
    .where(
      and(
        eq(gatekeeperVerdicts.mailAccountId, mailAccountId),
        or(
          and(
            eq(gatekeeperVerdicts.scope, "address"),
            inArray(gatekeeperVerdicts.value, normalized),
          ),
          // `inArray` with an empty list is not valid SQL — skipped entirely
          // when every address's domain is barred or unparseable.
          domains.length > 0
            ? and(
                eq(gatekeeperVerdicts.scope, "domain"),
                inArray(gatekeeperVerdicts.value, domains),
              )
            : undefined,
        ),
      ),
    );

  const byAddress = new Map<string, { verdict: GatekeeperVerdict; spam: boolean }>();
  const byDomain = new Map<string, { verdict: GatekeeperVerdict; spam: boolean }>();
  for (const row of rows) {
    (row.scope === "address" ? byAddress : byDomain).set(row.value, {
      verdict: row.verdict,
      spam: row.spam,
    });
  }

  for (const address of normalized) {
    const exact = byAddress.get(address);
    if (exact) {
      resolved.set(address, { verdict: exact.verdict, scope: "address", spam: exact.spam });
      continue;
    }
    const domain = senderDomain(address);
    const domainVerdict =
      domain && !isBarredVerdictDomain(domain) ? byDomain.get(domain) : undefined;
    resolved.set(
      address,
      domainVerdict
        ? { verdict: domainVerdict.verdict, scope: "domain", spam: domainVerdict.spam }
        : UNSCREENED,
    );
  }
  return resolved;
}

/** One address's Verdict. `null`/empty resolves to Unscreened rather than throwing — a `From`-less message has no sender to screen. */
export async function resolveVerdict(
  db: Db,
  mailAccountId: string,
  address: string | null,
): Promise<ResolvedVerdict> {
  if (!address) return UNSCREENED;
  const resolved = await resolveVerdicts(db, mailAccountId, [address]);
  return resolved.get(normalizeSenderAddress(address)) ?? UNSCREENED;
}

/** Reads one address out of a `resolveVerdicts` result, normalizing on the caller's behalf. */
export function verdictFor(
  resolved: Map<string, ResolvedVerdict>,
  address: string | null,
): ResolvedVerdict {
  if (!address) return UNSCREENED;
  return resolved.get(normalizeSenderAddress(address)) ?? UNSCREENED;
}

/**
 * A batch of recipient Aliases' Verdicts (#103), resolved in one round trip
 * the same "batch, not per-message" shape `resolveVerdicts` gives senders —
 * but a **sibling**, not a branch inside it: a recipient Verdict answers a
 * different question ("did this arrive at an Alias the User has given up
 * on?") that knows nothing about who sent the message, has no
 * address-beats-domain precedence to apply, and is Blocked-only, so there is
 * no `ResolvedVerdict` shape to build — just the set of Aliases, among the
 * ones asked about, that are currently Blocked.
 *
 * `gatekeeper/screening.ts#screenArrivals` is the one caller: it checks this
 * set *before* `resolveVerdicts`' sender resolution, because a Blocked Alias
 * "beats everything, including an Approved Sender" (CONTEXT.md) — the two
 * lookups never get to disagree, because the recipient one is asked first.
 */
export async function resolveBlockedAliases(
  db: Db,
  mailAccountId: string,
  aliases: readonly (string | null)[],
): Promise<Set<string>> {
  const normalized = [
    ...new Set(
      aliases.filter((alias): alias is string => alias !== null).map(normalizeSenderAddress),
    ),
  ];
  if (normalized.length === 0) return new Set();

  const rows = await db
    .select({ value: gatekeeperVerdicts.value })
    .from(gatekeeperVerdicts)
    .where(
      and(
        eq(gatekeeperVerdicts.mailAccountId, mailAccountId),
        eq(gatekeeperVerdicts.scope, "recipient"),
        eq(gatekeeperVerdicts.verdict, "blocked"),
        inArray(gatekeeperVerdicts.value, normalized),
      ),
    );
  return new Set(rows.map((row) => row.value));
}

export class BarredVerdictDomainError extends Error {
  constructor(readonly domain: string) {
    super(`${domain} is a public provider — a domain verdict there says nothing about a sender`);
    this.name = "BarredVerdictDomainError";
  }
}

/** A `recipient`-scoped Verdict was asked to be anything but `blocked` (#103: "Blocked only — no Approved Alias"). */
export class RecipientVerdictMustBeBlockedError extends Error {
  constructor(readonly alias: string) {
    super(`${alias} is a recipient Alias — Gatekeeper only ever blocks one, never approves it`);
    this.name = "RecipientVerdictMustBeBlockedError";
  }
}

/** A `recipient`-scoped Verdict named the Mail Account's own primary address (#103's own refusal). */
export class PrimaryAddressVerdictError extends Error {
  constructor(readonly address: string) {
    super(`${address} is this Mail Account's own address — Gatekeeper cannot block it`);
    this.name = "PrimaryAddressVerdictError";
  }
}

/**
 * Writes one Verdict, replacing whatever this account already said about
 * that exact key. `updatedAt` moves on every write and `source` records who
 * decided, which together are poc-spec.md's "source + timestamp recorded on
 * every verdict" — a re-approval by a live send genuinely is a newer, better
 * answer than an old seed, so it overwrites rather than being absorbed.
 *
 * Throws `BarredVerdictDomainError` for a domain Verdict on a public
 * provider, `RecipientVerdictMustBeBlockedError` for a `recipient`-scoped
 * Verdict that isn't `blocked`, and `PrimaryAddressVerdictError` for a
 * `recipient`-scoped Verdict naming the Mail Account's own address (#103) —
 * a throw rather than a silent skip in every case: every caller has a
 * User-facing way to say no (a rejected mutation, a 400), and silently doing
 * nothing would leave a Screener row looking decided when it isn't.
 *
 * `spam` (#102) is only ever meaningful alongside `verdict: "blocked"` —
 * `spamSender` (`gatekeeper/decisions.ts`) is the only caller that passes
 * `true`; every other caller's `false` default keeps a plain Block from
 * accidentally routing to Junk. Nothing calls `spamSender` with `recipient`
 * scope — Blocked Alias mirrors a plain Block, never Spam.
 */
export async function setVerdict(
  db: Db,
  mailAccountId: string,
  sender: { scope: GatekeeperScope; value: string },
  verdict: "approved" | "blocked",
  source: GatekeeperVerdictSource,
  spam = false,
): Promise<void> {
  const value = normalizeSenderAddress(sender.value);
  if (sender.scope === "domain" && isBarredVerdictDomain(value)) {
    throw new BarredVerdictDomainError(value);
  }
  if (sender.scope === "recipient") {
    if (verdict !== "blocked") {
      throw new RecipientVerdictMustBeBlockedError(value);
    }
    const account = await getMailAccountById(db, mailAccountId);
    if (account && normalizeSenderAddress(account.emailAddress) === value) {
      throw new PrimaryAddressVerdictError(value);
    }
  }
  const now = new Date();
  await db
    .insert(gatekeeperVerdicts)
    .values({
      id: gatekeeperVerdictId(mailAccountId, sender.scope, value),
      mailAccountId,
      scope: sender.scope,
      value,
      verdict,
      spam,
      source,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: gatekeeperVerdicts.id,
      set: { verdict, spam, source, updatedAt: now },
    });
}

/** Clears one Verdict back to Unscreened (Deny leaves nothing behind; unblock removes a Block). Silent on a key with no row. */
export async function clearVerdict(
  db: Db,
  mailAccountId: string,
  sender: { scope: GatekeeperScope; value: string },
): Promise<void> {
  await db
    .delete(gatekeeperVerdicts)
    .where(
      eq(gatekeeperVerdicts.id, gatekeeperVerdictId(mailAccountId, sender.scope, sender.value)),
    );
}

/** Every Verdict on this Mail Account — what Reset Gatekeeper clears before it re-seeds. */
export async function clearAllVerdicts(db: Db, mailAccountId: string): Promise<void> {
  await db.delete(gatekeeperVerdicts).where(eq(gatekeeperVerdicts.mailAccountId, mailAccountId));
}

/** The Blocked Senders list (poc-spec.md), newest decision first. Small by nature — no windowing. */
export async function listBlockedSenders(db: Db, mailAccountId: string): Promise<BlockedSender[]> {
  const rows = await db
    .select({
      scope: gatekeeperVerdicts.scope,
      value: gatekeeperVerdicts.value,
      source: gatekeeperVerdicts.source,
      spam: gatekeeperVerdicts.spam,
      updatedAt: gatekeeperVerdicts.updatedAt,
    })
    .from(gatekeeperVerdicts)
    .where(
      and(
        eq(gatekeeperVerdicts.mailAccountId, mailAccountId),
        eq(gatekeeperVerdicts.verdict, "blocked"),
      ),
    )
    .orderBy(desc(gatekeeperVerdicts.updatedAt));
  return rows.map((row) => ({
    scope: row.scope,
    value: row.value,
    source: row.source,
    spam: row.spam,
    decidedAt: row.updatedAt.toISOString(),
  }));
}

/** How many senders this account currently approves — the seed's only visible output. */
export async function countApprovedSenders(db: Db, mailAccountId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(gatekeeperVerdicts)
    .where(
      and(
        eq(gatekeeperVerdicts.mailAccountId, mailAccountId),
        eq(gatekeeperVerdicts.verdict, "approved"),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Seeds Approved from Sent history (poc-spec.md: "Enabling sets the Cutoff
 * to now and **seeds Approved from Sent history**"). Everyone this Mail
 * Account has ever written to is someone the User already chose to talk to,
 * which is what makes day one of screening an *empty* Screener rather than a
 * thousand-stranger backlog.
 *
 * One statement rather than a paged read-and-upsert loop: a fifteen-year
 * mailbox's Sent folder is tens of thousands of messages with tens of
 * thousands of recipients between them, and enabling Gatekeeper is a
 * foreground action the User is waiting on. `on conflict do nothing` is what
 * makes it safe to re-run — notably it will never demote a Blocked sender
 * back to Approved just because they were once mailed.
 *
 * Address scope only. A domain seed would approve every stranger at every
 * company the User has ever emailed, which is not what "I wrote to this
 * person" says.
 *
 * Returns how many Verdicts were actually written.
 */
export async function seedApprovedFromSentHistory(db: Db, mailAccountId: string): Promise<number> {
  const inserted = await db.execute(sql`
    insert into ${gatekeeperVerdicts} (
      id, mail_account_id, scope, value, verdict, source, created_at, updated_at
    )
    select distinct
      ${mailAccountId} || ':address:' || s.addr,
      ${mailAccountId},
      'address',
      s.addr,
      'approved',
      'seed',
      now(),
      now()
    from (
      select lower(btrim(recipient->>'address')) as addr
      from ${messages} m
      join ${folders} f on f.id = m.folder_id
      cross join lateral jsonb_array_elements(m.to_addresses || m.cc_addresses) as recipient
      where m.mail_account_id = ${mailAccountId} and f.role = 'sent'
    ) s
    where s.addr <> '' and strpos(s.addr, '@') > 1
    on conflict (id) do nothing
    returning id
  `);
  return inserted.length;
}

/**
 * "Sending approves live" (poc-spec.md). Called on a *successful* send only
 * (`compose/send-sweeper.ts`), not when a Pending Send is accepted: a send
 * that never reached a mail server is not a conversation the User started,
 * and approving off an accepted-then-cancelled send would let a typo'd
 * address through the Screener forever.
 *
 * Never overwrites a Blocked verdict — `onConflictDoNothing` on the block
 * branch would be wrong (a live send genuinely is a newer decision), but so
 * would silently unblocking someone the User deliberately blocked and then
 * happened to reply to. Blocked wins; the explicit unblock in Settings is
 * the way back.
 */
export async function approveSendRecipients(
  db: Db,
  mailAccountId: string,
  addresses: readonly string[],
): Promise<void> {
  const normalized = [...new Set(addresses.map(normalizeSenderAddress))].filter(
    (address) => address.length > 0 && senderDomain(address) !== null,
  );
  if (normalized.length === 0) return;

  const existing = await resolveVerdicts(db, mailAccountId, normalized);
  for (const address of normalized) {
    if (verdictFor(existing, address).verdict === "blocked") continue;
    await setVerdict(db, mailAccountId, { scope: "address", value: address }, "approved", "sent");
  }
}
