import { randomUUID } from "node:crypto";
import { and, asc, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type NotifierOutboxPayload, notifierOutbox } from "../db/schema.js";

/**
 * The Notifier's durable outbox (#53, ADR-0015) — see `db/schema.ts`'s own
 * doc comment on `notifierOutbox` for why this exists and what its dedup
 * index is (and is not) for.
 */

export type NotifierOutboxRow = typeof notifierOutbox.$inferSelect;

export interface InsertOutboxEntryInput {
  userId: string;
  mailAccountId: string;
  kind: NotifierOutboxPayload["kind"];
  /** Unique within `kind` — see `db/schema.ts`'s doc comment for what each kind uses. */
  dedupKey: string;
  payload: NotifierOutboxPayload;
}

/**
 * Inserts one outbox row, silently absorbing a dedup collision
 * (`ON CONFLICT DO NOTHING`) — the accidental-double-insert backstop, not
 * the primary correctness guarantee (see the schema doc comment). Returns
 * whether a row was actually inserted, mostly useful for tests.
 */
export async function insertOutboxEntry(db: Db, input: InsertOutboxEntryInput): Promise<boolean> {
  const [row] = await db
    .insert(notifierOutbox)
    .values({
      id: randomUUID(),
      userId: input.userId,
      mailAccountId: input.mailAccountId,
      kind: input.kind,
      dedupKey: input.dedupKey,
      payload: input.payload,
    })
    .onConflictDoNothing({ target: [notifierOutbox.kind, notifierOutbox.dedupKey] })
    .returning({ id: notifierOutbox.id });
  return row !== undefined;
}

/** Every undelivered row, oldest first — `deliver.ts`'s own candidate query, across every Mail Account with anything pending. */
export async function listUndelivered(db: Db): Promise<NotifierOutboxRow[]> {
  return db
    .select()
    .from(notifierOutbox)
    .where(isNull(notifierOutbox.deliveredAt))
    .orderBy(asc(notifierOutbox.createdAt));
}

/** Marks a batch of rows delivered in one statement — `deliver.ts` calls this once per Mail Account per tick, not once per row. */
export async function markDelivered(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(notifierOutbox)
    .set({ deliveredAt: new Date() })
    .where(and(inArray(notifierOutbox.id, ids), isNull(notifierOutbox.deliveredAt)));
}
