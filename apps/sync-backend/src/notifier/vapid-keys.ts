import webPush from "web-push";
import type { Db } from "../db/client.js";
import { VAPID_KEYS_ROW_ID, vapidKeys } from "../db/schema.js";
import {
  deriveCredentialKey,
  sealSecret,
  unsealSecret,
} from "../mail-accounts/credential-crypto.js";

/**
 * Where the instance's Web Push VAPID keypair comes from (#53, ADR-0015 as
 * amended).
 *
 * The original decision put the keypair in the environment only, generated
 * by the operator CLI, on the grounds that "auto-generating into the
 * database would silently invalidate every subscription on a volume-restore
 * mismatch". The amendment keeps the *fear* and drops the *conclusion*: what
 * kills a subscription is a keypair changing under it, and a keypair sitting
 * in `vapid_keys` changes strictly less often than one sitting in an env
 * var, because a database restore carries it back alongside the very
 * `push_subscriptions` rows it signs. An env var is the half that can go
 * missing on its own.
 *
 * So generation is allowed, and the invariant that matters is enforced here
 * rather than by refusing to generate at all: **a working keypair is never
 * replaced.** `ensure` mints one only when there is none, and the single
 * exception (`repair`) is a stored keypair that can no longer be unsealed
 * with this instance's `MAIL_CREDENTIAL_KEY` — already unusable for signing,
 * so re-minting it is the repair rather than the damage, and it takes an
 * explicit Owner action to happen.
 *
 * An operator who *does* pin `MAIL_VAPID_PUBLIC_KEY`/`MAIL_VAPID_PRIVATE_KEY`
 * keeps exactly today's behaviour: the env pair wins over any stored row,
 * nothing is ever generated, and `canGenerate` is false so the Instance page
 * offers the CLI command instead of a button that the next boot would
 * override.
 */

export interface VapidKeypair {
  publicKey: string;
  privateKey: string;
}

export interface VapidKeyStore {
  /**
   * The keypair in force, or `null` when there is none (a fresh instance
   * before `ensure`, or a stored row this build cannot unseal). Read per
   * request rather than captured at boot, so a keypair minted from the
   * Instance page takes effect without a restart.
   */
  read(): Promise<VapidKeypair | null>;
  /** Just the public half — what `GET /push/config` and the Instance page quote. */
  readPublicKey(): Promise<string | null>;
  /** Whether this instance owns the keypair (and so may generate one) rather than reading it from the environment. */
  canGenerate: boolean;
  /**
   * The keypair in force, minting and storing one if there is none. A no-op
   * on every boot after the first, and on an env-pinned instance. `null`
   * only when a stored row exists that cannot be unsealed — `repair` is that
   * case's deliberate, Owner-driven way out.
   */
  ensure(): Promise<VapidKeypair | null>;
  /**
   * Mints a keypair even though a row already exists, for the one case where
   * the stored one cannot be unsealed. Refuses (returns `null`) whenever the
   * existing keypair is readable — that would be the silent
   * subscription-invalidation the ADR rules out.
   */
  repair(): Promise<VapidKeypair | null>;
}

export interface VapidKeyStoreOptions {
  /** `env.MAIL_CREDENTIAL_KEY` — the private half is sealed under it (ADR-0003), exactly like a Mail Account password. */
  mailCredentialKey: string;
  /** `env.MAIL_VAPID_PUBLIC_KEY`/`_PRIVATE_KEY` when the operator pinned them; the store then reads through to these and never generates. */
  envKeypair?: VapidKeypair | null;
  /** Injected so a test can assert *which* keypair was stored without generating a real one. */
  generate?: () => VapidKeypair;
  /** Called once when a stored keypair cannot be unsealed — `main.ts` logs it; silent by default. */
  onUnsealFailure?: (error: unknown) => void;
}

function defaultGenerate(): VapidKeypair {
  const keys = webPush.generateVAPIDKeys();
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

export function createVapidKeyStore(db: Db, options: VapidKeyStoreOptions): VapidKeyStore {
  const {
    mailCredentialKey,
    envKeypair = null,
    generate = defaultGenerate,
    onUnsealFailure,
  } = options;
  const key = deriveCredentialKey(mailCredentialKey);
  let warned = false;

  /** `undefined` = no row; `null` = a row that will not unseal — two cases only this module needs to tell apart. */
  async function readStored(): Promise<VapidKeypair | null | undefined> {
    const [row] = await db.select().from(vapidKeys).limit(1);
    if (!row) return undefined;
    try {
      return { publicKey: row.publicKey, privateKey: unsealSecret(row.privateKey, row.id, key) };
    } catch (error) {
      if (!warned) {
        warned = true;
        onUnsealFailure?.(error);
      }
      return null;
    }
  }

  /**
   * `replace: false` is the first-mint path and is deliberately
   * insert-only: two app containers booting at once would otherwise race,
   * and the loser's keypair would overwrite the winner's — the very
   * "silently invalidate every subscription" failure this design has to
   * avoid. Whoever inserts first wins, and the other reads that row back.
   * `replace: true` is only ever `repair`, an explicit Owner action against
   * a keypair that cannot be opened anyway.
   */
  async function store(keypair: VapidKeypair, replace: boolean): Promise<VapidKeypair> {
    const values = {
      id: VAPID_KEYS_ROW_ID,
      publicKey: keypair.publicKey,
      privateKey: sealSecret(keypair.privateKey, VAPID_KEYS_ROW_ID, key),
    };
    if (replace) {
      await db
        .insert(vapidKeys)
        .values(values)
        .onConflictDoUpdate({
          target: vapidKeys.id,
          set: { ...values, createdAt: new Date() },
        });
      warned = false;
      return keypair;
    }

    await db.insert(vapidKeys).values(values).onConflictDoNothing();
    warned = false;
    // Whatever is in the row now — ours, or a concurrent booter's.
    const stored = await readStored();
    return stored ?? keypair;
  }

  async function read(): Promise<VapidKeypair | null> {
    if (envKeypair) return envKeypair;
    return (await readStored()) ?? null;
  }

  return {
    canGenerate: envKeypair === null,
    read,
    async readPublicKey() {
      return (await read())?.publicKey ?? null;
    },
    async ensure() {
      if (envKeypair) return envKeypair;
      const stored = await readStored();
      if (stored) return stored;
      // `null` (a row that won't unseal) deliberately falls through to
      // nothing rather than being overwritten here: silently re-minting on
      // every boot is what would kill live subscriptions. `repair` is the
      // Owner's explicit way to accept that cost.
      if (stored === null) return null;
      return store(generate(), false);
    },
    async repair() {
      if (envKeypair) return null;
      const stored = await readStored();
      if (stored) return null; // a readable keypair is never replaced
      return store(generate(), true);
    },
  };
}

/**
 * A store with no keypair that will never mint one — Web Push off. The
 * default `buildApp` uses (mirroring `noopSyncManager`/`noopSyncHintBroker`):
 * a test that never touches notifications gets the honest "this instance has
 * no keypair" answer without a database round trip, and `canGenerate: false`
 * keeps the Instance page from offering a button that would do nothing.
 */
export const disabledVapidKeyStore: VapidKeyStore = {
  canGenerate: false,
  read: async () => null,
  readPublicKey: async () => null,
  ensure: async () => null,
  repair: async () => null,
};
