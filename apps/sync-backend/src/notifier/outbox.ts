import { randomUUID } from "node:crypto";
import type { ConnectedAccountFacetKind } from "@mail/shared";
import { and, asc, inArray, isNull, lte, or } from "drizzle-orm";
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
  /** Null for a `needs_reauth` notification on a Calendar or Contacts Facet (#204) — every other kind always sets this. */
  mailAccountId: string | null;
  /** `needs_reauth` only (#204): which Connected Account/Facet parked. Absent (null) for every other kind. */
  connectedAccountId?: string | null;
  facet?: ConnectedAccountFacetKind | null;
  kind: NotifierOutboxPayload["kind"];
  /** Unique within `kind` — see `db/schema.ts`'s doc comment for what each kind uses. */
  dedupKey: string;
  payload: NotifierOutboxPayload;
  /** `calendar_answer` only (#243) — every other kind leaves this `null`, "ready the moment it's recorded" exactly as before. */
  readyAt?: Date | null;
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
      connectedAccountId: input.connectedAccountId ?? null,
      facet: input.facet ?? null,
      kind: input.kind,
      dedupKey: input.dedupKey,
      payload: input.payload,
      readyAt: input.readyAt ?? null,
    })
    .onConflictDoNothing({ target: [notifierOutbox.kind, notifierOutbox.dedupKey] })
    .returning({ id: notifierOutbox.id });
  return row !== undefined;
}

/**
 * Every undelivered *and ready* row, oldest first — `deliver.ts`'s own
 * candidate query, across every Mail Account with anything pending.
 * `readyAt` is `null` for every kind but `calendar_answer` (#243), which is
 * exactly "ready the instant it's recorded" — the same tolerant `OR` shape
 * `local-answer.ts#isDue` gives a Reply.
 */
export async function listUndelivered(
  db: Db,
  now: Date = new Date(),
): Promise<NotifierOutboxRow[]> {
  return db
    .select()
    .from(notifierOutbox)
    .where(
      and(
        isNull(notifierOutbox.deliveredAt),
        or(isNull(notifierOutbox.readyAt), lte(notifierOutbox.readyAt, now)),
      ),
    )
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
