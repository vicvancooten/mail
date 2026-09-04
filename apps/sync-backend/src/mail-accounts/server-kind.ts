import type { ImapFlow } from "imapflow";

/**
 * A Mail Account's server kind (ADR-0020, #121): `gmail` once the write
 * paths this unblocks (label ops instead of moves, `docs/adr/0020-...md`)
 * land, `generic` for every other IMAP server. Persisted on `mailAccounts`
 * (`db/schema.ts#serverKind`) so those paths can branch from the row alone,
 * without a live connection.
 */
export type MailAccountServerKind = "gmail" | "generic";

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
export function detectServerKind(client: Pick<ImapFlow, "capabilities">): MailAccountServerKind {
  return client.capabilities.has(GMAIL_CAPABILITY) ? "gmail" : "generic";
}
