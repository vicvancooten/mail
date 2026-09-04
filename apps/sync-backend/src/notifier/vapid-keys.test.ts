import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import { VAPID_KEYS_ROW_ID, vapidKeys as vapidKeysTable } from "../db/schema.js";
import { deriveCredentialKey, sealSecret } from "../mail-accounts/credential-crypto.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createVapidKeyStore, type VapidKeypair, type VapidKeyStoreOptions } from "./vapid-keys.js";

/**
 * ADR-0015 as amended: the instance mints its own Web Push keypair. The
 * invariant every case here circles is the one the original decision was
 * protecting — **a working keypair is never replaced**, because every live
 * subscription is bound to the key it was created under.
 */

let db: Db;
let closeDb: () => Promise<void>;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

const MINTED: VapidKeypair = { publicKey: "minted-public", privateKey: "minted-private" };

function store(options: Partial<VapidKeyStoreOptions> = {}) {
  return createVapidKeyStore(db, {
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    generate: () => MINTED,
    ...options,
  });
}

describe("createVapidKeyStore", () => {
  it("has no keypair before anything mints one", async () => {
    const keys = store({});
    expect(await keys.read()).toBeNull();
    expect(await keys.readPublicKey()).toBeNull();
    expect(keys.canGenerate).toBe(true);
  });

  it("mints and stores a keypair on `ensure`, sealed rather than in the clear", async () => {
    const keys = store({});
    expect(await keys.ensure()).toEqual(MINTED);

    const [row] = await db.select().from(vapidKeysTable);
    expect(row?.id).toBe(VAPID_KEYS_ROW_ID);
    expect(row?.publicKey).toBe("minted-public");
    // ADR-0003's bar: the database alone cannot push to anyone's devices.
    expect(JSON.stringify(row?.privateKey)).not.toContain("minted-private");
    expect(row?.privateKey.keyVersion).toBe(1);
  });

  it("returns the same keypair on every later `ensure` — a second boot never re-mints", async () => {
    const first = store({});
    await first.ensure();

    const generate = vi.fn(() => ({ publicKey: "second", privateKey: "second-private" }));
    const second = store({ generate });
    expect(await second.ensure()).toEqual(MINTED);
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses to replace a readable keypair even when asked to repair one", async () => {
    const keys = store({});
    await keys.ensure();
    expect(await keys.repair()).toBeNull();
    expect(await keys.readPublicKey()).toBe("minted-public");
  });

  it("reads the env pair through, stores nothing, and reports it cannot generate", async () => {
    const envKeypair = { publicKey: "env-public", privateKey: "env-private" };
    const keys = store({ envKeypair });

    expect(keys.canGenerate).toBe(false);
    expect(await keys.read()).toEqual(envKeypair);
    expect(await keys.ensure()).toEqual(envKeypair);
    expect(await keys.repair()).toBeNull();
    expect(await db.select().from(vapidKeysTable)).toHaveLength(0);
  });

  it("prefers the env pair over a stored row, so an env-pinned instance is unchanged by this table", async () => {
    await store({}).ensure();
    const keys = store({ envKeypair: { publicKey: "env-public", privateKey: "env-private" } });
    expect(await keys.readPublicKey()).toBe("env-public");
  });

  describe("a stored keypair that cannot be unsealed", () => {
    /** Sealed under a *different* instance key — what a rotated `MAIL_CREDENTIAL_KEY` leaves behind. */
    async function seedUnopenable(): Promise<void> {
      await db.insert(vapidKeysTable).values({
        id: VAPID_KEYS_ROW_ID,
        publicKey: "orphaned-public",
        privateKey: sealSecret(
          "orphaned-private",
          VAPID_KEYS_ROW_ID,
          deriveCredentialKey("a-completely-different-instance-key-32b"),
        ),
      });
    }

    it("reports no keypair, and says so once rather than on every read", async () => {
      await seedUnopenable();
      const onUnsealFailure = vi.fn();
      const keys = store({ onUnsealFailure });

      expect(await keys.read()).toBeNull();
      expect(await keys.read()).toBeNull();
      expect(onUnsealFailure).toHaveBeenCalledTimes(1);
    });

    it("is left alone by `ensure` — a boot loop must not re-mint over live subscriptions", async () => {
      await seedUnopenable();
      const generate = vi.fn(() => MINTED);
      expect(await store({ generate }).ensure()).toBeNull();
      expect(generate).not.toHaveBeenCalled();

      const [row] = await db.select().from(vapidKeysTable);
      expect(row?.publicKey).toBe("orphaned-public");
    });

    it("is the one case `repair` replaces, since it cannot sign anything as it stands", async () => {
      await seedUnopenable();
      const keys = store({});

      expect(await keys.repair()).toEqual(MINTED);
      expect(await keys.readPublicKey()).toBe("minted-public");
      expect(await db.select().from(vapidKeysTable)).toHaveLength(1);
    });
  });

  it("keeps whichever keypair landed first when two instances mint concurrently", async () => {
    // Two containers booting at once: `ensure` is insert-only, so the loser
    // reads the winner's row back instead of overwriting it.
    const first = store({});
    const second = store({ generate: () => ({ publicKey: "other", privateKey: "other-private" }) });

    const [a, b] = await Promise.all([first.ensure(), second.ensure()]);
    expect(a?.publicKey).toBe(b?.publicKey);
    expect(await db.select().from(vapidKeysTable)).toHaveLength(1);
  });
});
