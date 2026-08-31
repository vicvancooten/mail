import { ImapFlow } from "imapflow";
import type { Db } from "../db/client.js";
import { unsealPasswordCredential } from "../mail-accounts/credential-crypto.js";
import { type MailAccountRow, markNeedsReauth } from "../mail-accounts/store.js";

/**
 * The one IMAP connection a Mail Account gets (ADR-0005: "one IMAP
 * connection per Mail Account"). #35 keeps one of these alive holding IDLE;
 * this ticket opens one, ingests, and logs out.
 *
 * The credential never leaves this file in plaintext: it is unsealed from
 * the ADR-0003 envelope, handed to ImapFlow, and never returned to a caller.
 */

/** ImapFlow's own default is 5 minutes; a sync loop that wedges that long is a hung sync. */
const SOCKET_TIMEOUT_MS = 60_000;

/**
 * Thrown when the mail server rejects the stored credential. The account is
 * already parked in Needs Reauth by the time this surfaces — callers should
 * stop syncing it rather than retry (ADR-0011: "`Needs Reauth` → stop, hold
 * the queue indefinitely ... Never retried").
 */
export class MailAccountNeedsReauthError extends Error {
  constructor(
    readonly mailAccountId: string,
    detail: string,
  ) {
    super(`Mail Account ${mailAccountId} needs reauth: ${detail}`);
    this.name = "MailAccountNeedsReauthError";
  }
}

export interface ImapConnectionOptions {
  /** `env.MAIL_CREDENTIAL_KEY` already hashed to a key (`deriveCredentialKey`). */
  credentialKey: Buffer;
  /** Surfaces ImapFlow's protocol chatter while debugging; silent by default. */
  logger?: ConstructorParameters<typeof ImapFlow>[0]["logger"];
}

/**
 * Opens and authenticates a connection for one Mail Account.
 *
 * A rejected credential is not an error the caller has to recognize: this
 * calls #33's `markNeedsReauth` seam first, so the state machine CONTEXT.md
 * describes ("syncing stops until the User supplies new credentials, and
 * pending Optimistic Actions wait rather than fail") is entered exactly
 * once, at the only place that can actually observe the rejection.
 */
export async function connectMailAccount(
  db: Db,
  account: MailAccountRow,
  { credentialKey, logger = false }: ImapConnectionOptions,
): Promise<ImapFlow> {
  const password = unsealPasswordCredential(account.credential, account.id, credentialKey);
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    // `secure: true` is implicit TLS on connect; `starttls`/`none` connect in
    // plaintext and upgrade opportunistically, which is what GreenMail's dev
    // listener needs (docs/dev-setup.md). Same convention as
    // `mail-accounts/verify.ts`.
    secure: account.imapSecurity === "tls",
    auth: { user: account.username, pass: password },
    logger,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // QRESYNC is #35's; asking for it here would change what the server
    // reports on SELECT before anything is ready to apply those deltas.
    qresync: false,
  });

  try {
    await client.connect();
  } catch (err) {
    client.close();
    if (isAuthFailure(err)) {
      await markNeedsReauth(db, account.id);
      throw new MailAccountNeedsReauthError(account.id, err.message);
    }
    throw err;
  }

  return client;
}

/**
 * Runs `body` against a fresh connection and always closes it. Every entry
 * point into the sync engine goes through this rather than managing a
 * connection by hand — a leaked ImapFlow keeps a socket and a `vitest run`
 * hanging on it.
 */
export async function withMailAccountConnection<T>(
  db: Db,
  account: MailAccountRow,
  options: ImapConnectionOptions,
  body: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = await connectMailAccount(db, account, options);
  try {
    return await body(client);
  } finally {
    // `logout()` is the polite close but can itself hang on a wedged socket;
    // `close()` afterwards is what actually frees the handle.
    await client.logout().catch(() => undefined);
    client.close();
  }
}

/**
 * imapflow's `AuthenticationFailure` class is not actually exported from its
 * public API (only its `.d.ts` claims it is), so this duck-types on the one
 * property that declaration guarantees — the same call `verify.ts` makes.
 */
function isAuthFailure(err: unknown): err is Error & { authenticationFailed: true } {
  return err instanceof Error && "authenticationFailed" in err && err.authenticationFailed === true;
}
