import { eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { repairs } from "../db/schema.js";

/**
 * A one-off data repair (#284): a stable `name` and the effect to run under
 * it. Unlike a schema migration (`db/migrate.ts`), a repair reads and
 * rewrites row *content* through the same query surface every other store
 * module uses — nothing about it belongs in a `.sql` file, and it runs at
 * most once per instance rather than once per un-migrated database.
 */
export interface Repair {
  /**
   * The `repairs` table's own primary key (`db/schema.ts`'s doc comment) —
   * stable across every instance that has ever run this build. Never rename
   * an already-shipped repair: a rename reads as a fresh, unrun repair on an
   * instance that already completed it under the old name.
   */
  name: string;
  run: (tx: Tx) => Promise<void>;
}

/**
 * Runs every repair in `list` this instance hasn't recorded yet, in order —
 * meant to be called once from the boot path, right after `runMigrations()`
 * (`main.ts`), the same place `upgradeMailAccountsToConnectedAccounts` runs.
 *
 * A repair's own effect and its completion row commit in one transaction, so
 * a crash mid-repair leaves nothing recorded and the next boot retries it
 * from scratch rather than treating a half-applied repair as done. Fails
 * closed (ADR-0009): a repair that throws stops the boot, the same as a
 * failed migration — this is not a framework, just the one guarantee every
 * repair needs (runs once, records that it ran).
 */
export async function runRepairs(db: Db, list: readonly Repair[]): Promise<void> {
  for (const repair of list) {
    const [already] = await db
      .select({ id: repairs.id })
      .from(repairs)
      .where(eq(repairs.id, repair.name))
      .limit(1);
    if (already) continue;

    await db.transaction(async (tx) => {
      await repair.run(tx);
      await tx.insert(repairs).values({ id: repair.name }).onConflictDoNothing();
    });
  }
}
