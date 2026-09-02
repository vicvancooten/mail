import { ImapFlow } from "imapflow";
import type { BenchEnv } from "./env.js";
import { generateCorpus } from "./generate.js";
import { buildRfc822 } from "./mime.js";
import type { CorpusConfig } from "./types.js";

const FOLDERS = ["Sent", "Archive", "Trash"] as const;

export interface ImapLoadResult {
  accountsLoaded: number;
  messagesAppended: number;
  elapsedMs: number;
}

/**
 * Owner login per account: `owner-<n>@corpus-bench.example`. GreenMail's
 * `greenmail.users.login=email` + `greenmail.auth.disabled` (compose.dev.yaml)
 * means any address logs in with any password and gets its own mailbox —
 * this matches `ownerAddress()` in generate.ts, so a message's `fromAddress`
 * / `toAddresses` line up with whichever account's mailbox it lands in.
 */
function ownerLogin(mailAccountId: number): string {
  return `owner-${mailAccountId}@corpus-bench.example`;
}

/**
 * APPENDs a sample of the corpus into GreenMail over real IMAP. Sampled by
 * default (see CORPUS_IMAP_SAMPLE in env.ts) — each APPEND is a network
 * round trip, so the full 250k corpus takes tens of minutes; pass
 * `sampleSize: 0` for a full-corpus load once that wait is acceptable.
 */
export async function loadImap(
  config: CorpusConfig,
  env: BenchEnv,
  sampleSize: number,
): Promise<ImapLoadResult> {
  const startedAt = performance.now();
  const limit = sampleSize > 0 ? sampleSize : config.messageCount;

  const clients = new Map<number, ImapFlow>();
  for (let accountId = 1; accountId <= config.mailAccounts; accountId++) {
    const client = new ImapFlow({
      host: env.IMAP_TEST_HOST,
      port: env.IMAP_TEST_PORT,
      secure: false,
      auth: { user: ownerLogin(accountId), pass: "corpus-bench" },
      logger: false,
    });
    await client.connect();
    for (const folder of FOLDERS) {
      await client.mailboxCreate(folder).catch(() => undefined);
    }
    clients.set(accountId, client);
  }

  let messagesAppended = 0;
  try {
    for (const message of generateCorpus(config)) {
      if (messagesAppended >= limit) break;
      const client = clients.get(message.mailAccountId);
      if (!client) continue;
      await client.append(message.folder, buildRfc822(message), [], message.sentAt);
      messagesAppended++;
    }
  } finally {
    for (const client of clients.values()) {
      await client.logout().catch(() => client.close());
    }
  }

  return {
    accountsLoaded: clients.size,
    messagesAppended,
    elapsedMs: performance.now() - startedAt,
  };
}
