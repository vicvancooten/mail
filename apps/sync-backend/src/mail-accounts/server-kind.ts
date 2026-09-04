import type { MailAccountServerKind } from "@mail/shared";
import type { ImapFlow } from "imapflow";

/**
 * A Mail Account's server kind (ADR-0020, #121): `gmail` once the write
 * paths this unblocks (label ops instead of moves, `docs/adr/0020-...md`)
 * land, `generic` for every other IMAP server, `null` until verification or
 * a connect has detected it. Persisted on `mailAccounts`
 * (`db/schema.ts#serverKind`) so those paths can branch from the row alone,
 * without a live connection. `@mail/shared`'s `mailAccountServerKindSchema`
 * is the one true definition (it rides the wire too) — re-exported here so
 * every backend caller reads the DB column's own nullability off the same
 * type rather than hand-spelling `MailAccountServerKind | null` themselves.
 */
export type { MailAccountServerKind };

/**
 * The non-null half of `MailAccountServerKind` — what a live detection
 * (`detectServerKind`, `mail-accounts/verify.ts`) always produces, and what
 * `mail-accounts/store.ts`'s insert/replace/update-server-kind writes always
 * carry: a *freshly detected* kind is never "not yet known". Derived from the
 * one canonical type with `Exclude`, not redeclared, so the two can never
 * drift apart the way the pre-consolidation pair did.
 */
export type DetectedMailAccountServerKind = Exclude<MailAccountServerKind, null>;

/**
 * Whether a Mail Account's server kind is Gmail — the one comparison every
 * Gmail-specific branch across the Sync Backend makes, in place of each
 * hand-spelling its own `serverKind === "gmail"`. `null`/`undefined` (not yet
 * detected, #121, or no account row at all) reads as `false`, same as
 * `"generic"`.
 */
export function isGmailAccount(kind: MailAccountServerKind | undefined): boolean {
  return kind === "gmail";
}

/**
 * Gmail advertises this capability on every account regardless of how the
 * credential was obtained — ADR-0020's "selection by server capability, not
 * credential kind", so an app-password Gmail account added through Other
 * IMAP is detected exactly like one added by Google sign-in.
 */
const GMAIL_CAPABILITY = "X-GM-EXT-1";

/**
 * Reads the server kind off an already-connected client's capability list.
 * `capabilities` is populated by imapflow as soon as `connect()` resolves
 * (from the greeting/CAPABILITY response), so this never needs a command of
 * its own — both call sites (`verify.ts`, `sync/imap-connection.ts`) already
 * hold an open connection when they call it.
 */
export function detectServerKind(
  client: Pick<ImapFlow, "capabilities">,
): DetectedMailAccountServerKind {
  return client.capabilities.has(GMAIL_CAPABILITY) ? "gmail" : "generic";
}
