import type { ComposeSave, ComposeSaveOutcome } from "@mail/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { composeSaveLedger, compositions } from "../db/schema.js";

/**
 * Applies one Mail Account's queued Composition autosaves (ADR-0014, #45).
 * Unlike `flushMutations`' FIFO array, `saves` carries **at most one entry
 * per Composition** — the Client's own coalescing queue
 * (`store/compositions.ts`) never holds more than that — so processing order
 * across different Compositions has no promised meaning, only exactly-once
 * per `saveId` does.
 */
export async function flushComposeSaves(
  db: Db,
  mailAccountId: string,
  saves: ComposeSave[],
): Promise<ComposeSaveOutcome[]> {
  const outcomes: ComposeSaveOutcome[] = [];
  for (const save of saves) {
    outcomes.push(await applyOne(db, mailAccountId, save));
  }
  return outcomes;
}

async function applyOne(
  db: Db,
  mailAccountId: string,
  save: ComposeSave,
): Promise<ComposeSaveOutcome> {
  const existing = await ledgerRow(db, save.saveId);
  if (existing) return toOutcome(save, existing);

  const result = await applySave(db, mailAccountId, save);
  try {
    await db.insert(composeSaveLedger).values({
      id: save.saveId,
      compositionId: save.id,
      status: result.status,
      version: result.version,
      reason: "reason" in result ? result.reason : null,
    });
  } catch (error) {
    // Same race the mutations ledger already tolerates (`sync/mutations.ts`):
    // a concurrent resend of the same `saveId` lost the ledger insert to
    // this one. The unique `id` primary key is the real correctness
    // barrier — falling back to whatever the winner recorded is harmless.
    if (isUniqueViolation(error)) {
      const row = await ledgerRow(db, save.saveId);
      if (row) return toOutcome(save, row);
    }
    throw error;
  }

  return {
    id: save.id,
    saveId: save.saveId,
    status: result.status,
    version: result.version,
    ...("reason" in result ? { reason: result.reason } : {}),
  };
}

type ApplyResult =
  | { status: "applied"; version: number }
  | { status: "conflict"; version: number }
  | { status: "rejected"; version: number; reason: string };

/**
 * The Composition row is created lazily on the first save for an id the
 * account has never seen (ADR-0012: "created lazily on first content").
 * `save.version` is ignored on that path — there is nothing to be stale
 * against yet — and the new row starts at version 1, the first real content
 * a Client can consider confirmed.
 *
 * An existing row checks `save.version` against its own (ADR-0012's
 * optimistic-concurrency rule): a match applies and bumps the version; a
 * mismatch is a `conflict`, never silently overwritten. A Composition no
 * longer in `draft` status (moved on by #46's send path) rejects outright —
 * autosave has nothing left to write into.
 */
async function applySave(db: Db, mailAccountId: string, save: ComposeSave): Promise<ApplyResult> {
  const [row] = await db
    .select({ status: compositions.status, version: compositions.version })
    .from(compositions)
    .where(and(eq(compositions.id, save.id), eq(compositions.mailAccountId, mailAccountId)))
    .limit(1);

  if (!row) {
    await db.insert(compositions).values({
      id: save.id,
      mailAccountId,
      subject: save.subject,
      document: save.document,
      toAddresses: save.to,
      ccAddresses: save.cc,
      bccAddresses: save.bcc,
      inReplyTo: save.inReplyTo,
      references: save.references,
      version: 1,
    });
    return { status: "applied", version: 1 };
  }

  if (row.status !== "draft") {
    return { status: "rejected", version: row.version, reason: "not_a_draft" };
  }
  if (row.version !== save.version) {
    return { status: "conflict", version: row.version };
  }

  const nextVersion = row.version + 1;
  await db
    .update(compositions)
    .set({
      subject: save.subject,
      document: save.document,
      toAddresses: save.to,
      ccAddresses: save.cc,
      bccAddresses: save.bcc,
      inReplyTo: save.inReplyTo,
      references: save.references,
      version: nextVersion,
      updatedAt: new Date(),
    })
    .where(eq(compositions.id, save.id));
  return { status: "applied", version: nextVersion };
}

async function ledgerRow(
  db: Db,
  saveId: string,
): Promise<{
  status: "applied" | "conflict" | "rejected";
  version: number;
  reason: string | null;
} | null> {
  const [row] = await db
    .select({
      status: composeSaveLedger.status,
      version: composeSaveLedger.version,
      reason: composeSaveLedger.reason,
    })
    .from(composeSaveLedger)
    .where(eq(composeSaveLedger.id, saveId))
    .limit(1);
  return row ?? null;
}

function toOutcome(
  save: ComposeSave,
  row: { status: "applied" | "conflict" | "rejected"; version: number; reason: string | null },
): ComposeSaveOutcome {
  return {
    id: save.id,
    saveId: save.saveId,
    status: row.status,
    version: row.version,
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}
