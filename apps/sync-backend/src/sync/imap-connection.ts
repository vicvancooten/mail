import { ImapFlow } from "imapflow";
import type { Db } from "../db/client.js";
import { toImapAuth, unsealMailAccountSecret } from "../mail-accounts/credential-auth.js";
import { needsGrantRefresh, refreshMailAccountGrant } from "../mail-accounts/grant-refresh.js";
import type { ProviderAdapters } from "../mail-accounts/provider-adapter.js";
import {
  getMailAccountById,
  type MailAccountRow,
  markNeedsReauth,
} from "../mail-accounts/store.js";
import { recordNeedsReauthNotification } from "../notifier/record.js";

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
  /**
   * Enables QRESYNC (#35): EXPUNGE notifications carry UID instead of
   * sequence number, and a `mailboxOpen`/`getMailboxLock` call that also
   * passes `changedSince`+`uidValidity` can resync across a reconnect
   * instead of re-scanning the whole folder. False by default — the bounded
   * one-shot ingest (#34) never resyncs, so asking for it there would only
   * change what the server reports on SELECT for no benefit. The resident
   * sync loop (`sync/live-session.ts`) is the one caller that sets it.
   */
  qresync?: boolean;
  /**
   * ImapFlow only starts IDLE after the connection has sat inactive this
   * long (default 15s — tuned for a client that issues occasional commands,
   * not a resident loop whose entire job is to be idling). The resident sync
   * loop (#35) passes something far shorter so it starts watching INBOX
   * moments after it finishes the baseline sync, not 15 seconds later.
   */
  autoIdleDelay?: number;
  /**
   * Enables #118's Grant refresh for an `oauth` Mail Account: a proactive
   * refresh before connecting when the access token is within
   * `safetyMarginMs` of expiry, and one reactive refresh-then-retry if the
   * server rejects it anyway. Omitted by `verify.ts`, `compose/submit.ts`
   * and every test that doesn't ask for it — those keep the pre-#118
   * behavior of an oauth rejection landing in Needs Reauth exactly like a
   * password's (#114). Only `sync/live-session.ts`'s resident loop wires
   * this in for real.
   */
  grantRefresh?: {
    adapters: ProviderAdapters;
    safetyMarginMs?: number;
    now?: () => Date;
  };
}

/**
 * Opens and authenticates a connection for one Mail Account.
 *
 * A rejected *password* is not an error the caller has to recognize: this
 * calls #33's `markNeedsReauth` seam first, so the state machine CONTEXT.md
 * describes ("syncing stops until the User supplies new credentials, and
 * pending Optimistic Actions wait rather than fail") is entered exactly
 * once, at the only place that can actually observe the rejection.
 *
 * A rejected *oauth* access token, with `grantRefresh` configured, gets one
 * chance to refresh first (#118, ADR-0021: "nothing but the Provider itself
 * can tell a withdrawn Grant from a bad day on the network apart") — only a
 * `withdrawn` refresh result reaches the same Needs Reauth transition;
 * `transient` surfaces as a plain retryable error instead.
 */
export async function connectMailAccount(
  db: Db,
  account: MailAccountRow,
  options: ImapConnectionOptions,
): Promise<ImapFlow> {
  let current = account;

  if (current.credential.kind === "oauth" && options.grantRefresh) {
    const { adapters, safetyMarginMs, now } = options.grantRefresh;
    if (needsGrantRefresh(current.credential, (now ?? (() => new Date()))(), safetyMarginMs)) {
      const outcome = await refreshMailAccountGrant(db, current, {
        credentialKey: options.credentialKey,
        adapters,
      });
      if (outcome.result === "withdrawn") {
        throw new MailAccountNeedsReauthError(current.id, outcome.detail);
      }
      if (outcome.result === "refreshed") {
        const refreshed = await getMailAccountById(db, current.id);
        if (refreshed) current = refreshed;
      }
      // `transient` and `skipped` fall through: whatever credential is on
      // hand (possibly still the soon-to-expire one) gets a connection
      // attempt anyway, since it may well still be valid for a bit longer.
    }
  }

  return attemptConnect(db, current, options, /* allowGrantRetry */ true);
}

async function attemptConnect(
  db: Db,
  account: MailAccountRow,
  options: ImapConnectionOptions,
  allowGrantRetry: boolean,
): Promise<ImapFlow> {
  const { credentialKey, logger = false, qresync = false, autoIdleDelay } = options;
  const secret = unsealMailAccountSecret(account.credential, account.id, credentialKey);
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    // `secure: true` is implicit TLS on connect; `starttls`/`none` connect in
    // plaintext and upgrade opportunistically, which is what GreenMail's dev
    // listener needs (docs/dev-setup.md). Same convention as
    // `mail-accounts/verify.ts`.
    secure: account.imapSecurity === "tls",
    auth: toImapAuth(account.username, secret),
    logger,
    socketTimeout: SOCKET_TIMEOUT_MS,
    qresync,
    ...(autoIdleDelay !== undefined ? { autoIdleDelay } : {}),
  });

  try {
    await client.connect();
  } catch (err) {
    client.close();
    if (!isAuthFailure(err)) throw err;

    if (account.credential.kind === "oauth" && options.grantRefresh && allowGrantRetry) {
      const outcome = await refreshMailAccountGrant(db, account, {
        credentialKey,
        adapters: options.grantRefresh.adapters,
      });
      if (outcome.result === "withdrawn") {
        throw new MailAccountNeedsReauthError(account.id, outcome.detail);
      }
      if (outcome.result === "refreshed") {
        const refreshed = await getMailAccountById(db, account.id);
        if (refreshed) return attemptConnect(db, refreshed, options, /* allowGrantRetry */ false);
        throw new Error(`Mail Account ${account.id} vanished mid Grant refresh.`);
      }
      // `transient` (or `skipped`, if the Registration/adapter vanished
      // mid-flight): a plain error, so the caller's ordinary backoff-and-
      // retry handles it rather than parking the account (#118: "retried as
      // a transient sync error").
      const detail = outcome.result === "transient" ? outcome.detail : outcome.reason;
      throw new Error(`Mail Account ${account.id} Grant refresh did not succeed: ${detail}`);
    }

    const transitioned = await markNeedsReauth(db, account.id);
    if (transitioned) await recordNeedsReauthNotification(db, transitioned);
    throw new MailAccountNeedsReauthError(account.id, err.message);
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
