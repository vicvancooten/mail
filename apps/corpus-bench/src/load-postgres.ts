import type postgres from "postgres";
import { generateCorpus } from "./generate.js";
import type { CorpusConfig } from "./types.js";

/**
 * `corpus_bench` is a schema of its own, never `public` — this is a
 * throwaway stand-in for the real Message/Thread tables (which don't exist
 * yet; see wayfinder ticket #23's resolution), not a preview of that design.
 * `resetBenchSchema` drops it cleanly so it never collides with product
 * migrations landing later in the same database.
 */
const SCHEMA = "corpus_bench";
const BATCH_SIZE = 5_000;

export async function resetBenchSchema(sql: postgres.Sql): Promise<void> {
  await sql`DROP SCHEMA IF EXISTS ${sql(SCHEMA)} CASCADE`;
}

export async function ensureBenchSchema(sql: postgres.Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql(SCHEMA)}`;
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(SCHEMA)}.messages (
      id text PRIMARY KEY,
      mail_account_id smallint NOT NULL,
      thread_id text NOT NULL,
      folder text NOT NULL,
      from_address text NOT NULL,
      to_addresses text[] NOT NULL,
      subject text NOT NULL,
      sent_at timestamptz NOT NULL,
      body_text text NOT NULL,
      body_html text,
      attachment_count smallint NOT NULL DEFAULT 0,
      size_bytes integer NOT NULL,
      search_doc tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(body_text, '')), 'B')
      ) STORED
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS messages_search_idx
      ON ${sql(SCHEMA)}.messages USING GIN (search_doc)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS messages_thread_idx
      ON ${sql(SCHEMA)}.messages (thread_id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS messages_mail_account_idx
      ON ${sql(SCHEMA)}.messages (mail_account_id, sent_at DESC)
  `;
}

export interface LoadResult {
  rowsInserted: number;
  elapsedMs: number;
}

export async function loadPostgres(sql: postgres.Sql, config: CorpusConfig): Promise<LoadResult> {
  const startedAt = performance.now();
  let batch: Record<string, unknown>[] = [];
  let rowsInserted = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    await sql`
      INSERT INTO ${sql(SCHEMA)}.messages ${sql(
        batch,
        "id",
        "mail_account_id",
        "thread_id",
        "folder",
        "from_address",
        "to_addresses",
        "subject",
        "sent_at",
        "body_text",
        "body_html",
        "attachment_count",
        "size_bytes",
      )}
      ON CONFLICT (id) DO NOTHING
    `;
    rowsInserted += batch.length;
    batch = [];
  };

  for (const message of generateCorpus(config)) {
    batch.push({
      id: message.id,
      mail_account_id: message.mailAccountId,
      thread_id: message.threadId,
      folder: message.folder,
      from_address: message.fromAddress,
      to_addresses: message.toAddresses,
      subject: message.subject,
      sent_at: message.sentAt,
      body_text: message.bodyText,
      body_html: message.bodyHtml,
      attachment_count: message.attachments.length,
      size_bytes: message.sizeBytes,
    });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  return { rowsInserted, elapsedMs: performance.now() - startedAt };
}
