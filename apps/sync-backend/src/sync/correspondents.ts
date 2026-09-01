import { correspondentId, normalizeCorrespondentAddress } from "@mail/shared";
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { correspondents, type MessageAddress } from "../db/schema.js";
import type { FolderRole } from "./folders.js";
import { recordTombstones } from "./tombstones.js";

/**
 * The Correspondent aggregate (#49, CONTEXT.md, compose-spec §Recipient
 * autocomplete): "sent-weight ≫ received-weight, with recency decay". Hooked
 * off `sync/ingest.ts#storeMessage`'s "genuinely new row" branch — the one
 * point every message this account will ever hold passes through exactly
 * once, whether it arrived via full backfill, the delta UID-diff fallback,
 * or as this account's own just-sent message once its Sent `APPEND` is
 * ingested like any other folder message. That single point of truth is
 * what makes counting exactly-once trivial: there is nowhere else a message
 * could be counted from, so there is no double-count to guard against and no
 * ledger table needed the way `applied_mutations` guards a retried intent.
 */

/** Sent mail says far more about who you'd address next than mail you merely received (compose-spec). */
const SENT_WEIGHT = 10;
const RECEIVED_WEIGHT = 1;

/** Recency decay's half-life: a Correspondent's weight halves every this many days since last contact. */
const HALF_LIFE_DAYS = 180;

/** compose-spec's "top ~500 by score" — the entire table is this Mail Account's synced collection (`collection-sync.ts`), so nothing else needs to know it's bounded. */
export const CORRESPONDENT_CAP = 500;

/** Only prune once meaningfully over the cap, so an ordinary backfill isn't re-sorting the table on every new address. */
const PRUNE_SLACK = 100;

/**
 * The score formula, as a SQL fragment over two column-or-expression
 * arguments — shared between the `INSERT` and `ON CONFLICT` branches of
 * `recordCorrespondentActivity`'s upsert below so the two can never drift
 * apart. Postgres has no cheap "read the row I just wrote" inside one
 * upsert statement, so both branches recompute it fresh from their own
 * inputs rather than one path writing raw counts and a second query
 * deriving the score.
 */
function scoreExpr(lastSeenAt: SQL, weighted: SQL) {
  return sql`power(0.5::double precision, extract(epoch from (now() - ${lastSeenAt})) / 86400.0 / ${HALF_LIFE_DAYS}) * ${weighted}`;
}

export interface CorrespondentActivity {
  address: string;
  name: string | null;
  direction: "sent" | "received";
  /** When the contact happened — the message's `sentAt`/`receivedAt`. */
  at: Date;
}

/**
 * Derives the Correspondent activity one newly-stored message represents.
 * A Sent-role folder's recipients are who *this account* mailed; every other
 * folder's `From` is who mailed *this account* — Drafts, Trash and Junk are
 * excluded, the first because a draft has not actually been exchanged with
 * anyone yet, the latter two so junk and deleted mail don't inflate a
 * Correspondent's standing (compose-spec never says so explicitly, but
 * "derived from message history" reads as *real* history).
 */
export function activityForMessage(
  folderRole: FolderRole | null,
  message: {
    fromAddress: MessageAddress | null;
    toAddresses: MessageAddress[];
    ccAddresses: MessageAddress[];
    sentAt: Date;
    receivedAt: Date;
  },
): CorrespondentActivity[] {
  if (folderRole === "trash" || folderRole === "junk" || folderRole === "drafts") return [];

  if (folderRole === "sent") {
    const seen = new Map<string, CorrespondentActivity>();
    for (const recipient of [...message.toAddresses, ...message.ccAddresses]) {
      const key = normalizeCorrespondentAddress(recipient.address);
      if (!seen.has(key)) {
        seen.set(key, {
          address: recipient.address,
          name: recipient.name,
          direction: "sent",
          at: message.sentAt,
        });
      }
    }
    return [...seen.values()];
  }

  if (!message.fromAddress) return [];
  return [
    {
      address: message.fromAddress.address,
      name: message.fromAddress.name,
      direction: "received",
      at: message.receivedAt,
    },
  ];
}

/**
 * Applies one message's worth of Correspondent activity. `entries` is
 * usually `activityForMessage`'s result for a single message — a handful of
 * rows at most — each upserted in one round trip apiece; the accompanying
 * `ingest.ts` doc comment explains why this only ever runs once per message
 * ever ingested, so there is no idempotency concern to design around here.
 */
export async function recordCorrespondentActivity(
  db: Db,
  mailAccountId: string,
  entries: CorrespondentActivity[],
): Promise<void> {
  for (const entry of entries) {
    await upsertCorrespondent(db, mailAccountId, entry);
  }
}

async function upsertCorrespondent(
  db: Db,
  mailAccountId: string,
  entry: CorrespondentActivity,
): Promise<void> {
  const normalized = normalizeCorrespondentAddress(entry.address);
  const id = correspondentId(mailAccountId, entry.address);
  const sentDelta = entry.direction === "sent" ? 1 : 0;
  const receivedDelta = entry.direction === "received" ? 1 : 0;
  const at = entry.at.toISOString();

  const insertWeighted = sql`(${SENT_WEIGHT}::double precision * ${sentDelta} + ${RECEIVED_WEIGHT}::double precision * ${receivedDelta})`;
  const updateLastSeen = sql`greatest(${correspondents.lastSeenAt}, excluded.last_seen_at)`;
  const updateWeighted = sql`(${SENT_WEIGHT}::double precision * (${correspondents.sentCount} + excluded.sent_count) + ${RECEIVED_WEIGHT}::double precision * (${correspondents.receivedCount} + excluded.received_count))`;

  await db.execute(sql`
    insert into ${correspondents} (
      id, mail_account_id, normalized_address, address, name,
      sent_count, received_count, last_seen_at, score, created_at, updated_at
    )
    values (
      ${id}, ${mailAccountId}, ${normalized}, ${entry.address}, ${entry.name},
      ${sentDelta}, ${receivedDelta}, ${at}::timestamptz,
      ${scoreExpr(sql`${at}::timestamptz`, insertWeighted)},
      now(), now()
    )
    on conflict (mail_account_id, normalized_address) do update set
      address = excluded.address,
      -- The longest display name ever seen for this address wins, on the
      -- assumption a fuller name ("Ann Chen" over a bare "Ann") is a better
      -- one to suggest with; a null never displaces an existing name.
      name = case
        when excluded.name is null then ${correspondents.name}
        when ${correspondents.name} is null then excluded.name
        when length(excluded.name) > length(${correspondents.name}) then excluded.name
        else ${correspondents.name}
      end,
      sent_count = ${correspondents.sentCount} + excluded.sent_count,
      received_count = ${correspondents.receivedCount} + excluded.received_count,
      last_seen_at = ${updateLastSeen},
      score = ${scoreExpr(updateLastSeen, updateWeighted)},
      updated_at = now()
  `);
}

/**
 * Trims a Mail Account's Correspondents back to the top ~500 by score
 * (compose-spec), writing a tombstone for every one it removes so a Client
 * that had synced a since-displaced address drops it on its next round.
 * Cheap to call after every batch: the `PRUNE_SLACK` means an ordinary
 * backfill — which mostly touches a bounded, already-known set of senders —
 * triggers the actual `DELETE` rarely, and the `correspondents_account_score
 * _idx` (`db/schema.ts`) makes the worst-first scan an index scan rather
 * than a sort of the whole table.
 */
export async function capCorrespondents(db: Db, mailAccountId: string): Promise<void> {
  const countRows = await db.execute<{ count: string }>(sql`
    select count(*)::text as count from ${correspondents}
    where ${correspondents.mailAccountId} = ${mailAccountId}
  `);
  const total = Number(countRows[0]?.count ?? 0);
  if (total <= CORRESPONDENT_CAP + PRUNE_SLACK) return;

  const excess = total - CORRESPONDENT_CAP;
  const removed = await db.execute<{ id: string }>(sql`
    delete from ${correspondents}
    where id in (
      select id from ${correspondents}
      where ${correspondents.mailAccountId} = ${mailAccountId}
      order by score asc
      limit ${excess}
    )
    returning id
  `);

  await recordTombstones(db, {
    mailAccountId,
    collection: "Correspondent",
    entityIds: [...removed].map((row) => row.id),
  });
}
