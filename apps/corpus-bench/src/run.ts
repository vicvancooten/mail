import { mkdir, writeFile } from "node:fs/promises";
import postgres from "postgres";
import { benchPostgresSearch } from "./bench-postgres.js";
import { benchClientIndex } from "./client-index.js";
import { loadBenchEnv } from "./env.js";
import { defaultConfig, generateCorpus } from "./generate.js";
import { loadImap } from "./load-imap.js";
import { ensureBenchSchema, loadPostgres, resetBenchSchema } from "./load-postgres.js";
import { formatMs } from "./stats.js";
import type { CorpusConfig } from "./types.js";

function summarizeCorpus(config: CorpusConfig) {
  let messages = 0;
  let html = 0;
  let withAttachments = 0;
  let sizeSum = 0;
  const threads = new Set<string>();
  const folders: Record<string, number> = {};

  for (const message of generateCorpus(config)) {
    messages++;
    threads.add(message.threadId);
    if (message.bodyHtml) html++;
    if (message.attachments.length > 0) withAttachments++;
    sizeSum += message.sizeBytes;
    folders[message.folder] = (folders[message.folder] ?? 0) + 1;
  }

  return {
    messages,
    threads: threads.size,
    avgThreadDepth: messages / threads.size,
    htmlRatio: html / messages,
    attachmentRatio: withAttachments / messages,
    avgSizeBytes: Math.round(sizeSum / messages),
    folders,
  };
}

async function cmdGenerate(config: CorpusConfig) {
  console.log(`Generating corpus — seed ${config.seed}, ${config.messageCount} messages target...`);
  const summary = summarizeCorpus(config);
  console.log(JSON.stringify(summary, null, 2));
}

async function cmdLoadPostgres(config: CorpusConfig, databaseUrl: string, reset: boolean) {
  const sql = postgres(databaseUrl);
  try {
    if (reset) await resetBenchSchema(sql);
    await ensureBenchSchema(sql);
    const result = await loadPostgres(sql, config);
    console.log(
      `Loaded ${result.rowsInserted} rows into corpus_bench.messages in ${formatMs(result.elapsedMs)}`,
    );
    return result;
  } finally {
    await sql.end();
  }
}

async function cmdBenchPostgres(databaseUrl: string) {
  const sql = postgres(databaseUrl);
  try {
    const result = await benchPostgresSearch(sql);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await sql.end();
  }
}

async function cmdBenchClient(config: CorpusConfig) {
  const result = await benchClientIndex(config);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function cmdLoadImap(config: CorpusConfig, env: ReturnType<typeof loadBenchEnv>) {
  const result = await loadImap(config, env, env.CORPUS_IMAP_SAMPLE);
  console.log(
    `Appended ${result.messagesAppended} messages across ${result.accountsLoaded} accounts ` +
      `in ${formatMs(result.elapsedMs)} (${formatMs(result.elapsedMs / result.messagesAppended)}/message)`,
  );
  return result;
}

async function cmdBenchAll(config: CorpusConfig, env: ReturnType<typeof loadBenchEnv>) {
  const corpus = summarizeCorpus(config);
  console.log("== Corpus ==");
  console.log(JSON.stringify(corpus, null, 2));

  console.log("\n== Loading Postgres (corpus_bench schema) ==");
  const pgLoad = await cmdLoadPostgres(config, env.DATABASE_URL, true);

  console.log("\n== Postgres full-text search benchmark ==");
  const pgBench = await cmdBenchPostgres(env.DATABASE_URL);

  console.log("\n== Client-side index (MiniSearch) benchmark ==");
  const clientBench = await cmdBenchClient(config);

  const report = {
    generatedAt: new Date().toISOString(),
    config,
    corpus,
    postgres: { load: pgLoad, search: pgBench },
    clientIndex: clientBench,
  };
  await mkdir(new URL("../results/", import.meta.url), { recursive: true });
  const outPath = new URL("../results/latest.json", import.meta.url);
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${outPath.pathname}`);
}

async function main() {
  const [, , command] = process.argv;
  const env = loadBenchEnv();
  const config = defaultConfig({
    seed: env.CORPUS_SEED,
    messageCount: env.CORPUS_MESSAGE_COUNT,
    threadCount: env.CORPUS_THREAD_COUNT,
    mailAccounts: env.CORPUS_MAIL_ACCOUNTS,
  });

  switch (command) {
    case "generate":
      return cmdGenerate(config);
    case "load:postgres":
      return void (await cmdLoadPostgres(
        config,
        env.DATABASE_URL,
        process.argv.includes("--reset"),
      ));
    case "bench:postgres":
      return void (await cmdBenchPostgres(env.DATABASE_URL));
    case "load:imap":
      return void (await cmdLoadImap(config, env));
    case "bench:client":
      return void (await cmdBenchClient(config));
    case "bench:all":
      return cmdBenchAll(config, env);
    default:
      console.error(
        "Usage: tsx src/run.ts <generate|load:postgres|bench:postgres|load:imap|bench:client|bench:all>",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
