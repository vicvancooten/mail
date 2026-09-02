import { z } from "zod";

/**
 * Config for the corpus generator and its loaders/benchmarks. Defaults match
 * the PoC acceptance bar's scale target (docs/poc-scope.md): 250,000
 * messages / ~80,000 threads across 2 Mail Accounts. CORPUS_SEED is fixed by
 * default so re-running `generate` reproduces byte-identical output — the
 * seed is the "seeding command" the resolution of wayfinder ticket #23
 * records, not a database dump.
 */
const envSchema = z.object({
  CORPUS_SEED: z.coerce.number().int().default(230823),
  CORPUS_MESSAGE_COUNT: z.coerce.number().int().positive().default(250_000),
  CORPUS_THREAD_COUNT: z.coerce.number().int().positive().default(80_000),
  CORPUS_MAIL_ACCOUNTS: z.coerce.number().int().positive().default(2),

  // A GreenMail IMAP APPEND round-trips over the network; measured at ~1ms/
  // message locally (see README), so the full corpus takes ~4 minutes — not
  // slow, but sampling keeps `load:imap` a fast smoke test by default. Pass
  // CORPUS_IMAP_SAMPLE=0 for a full-corpus load.
  CORPUS_IMAP_SAMPLE: z.coerce.number().int().nonnegative().default(5_000),

  DATABASE_URL: z.url().default("postgres://mail:mail@localhost:5432/mail"),
  IMAP_TEST_HOST: z.string().default("localhost"),
  IMAP_TEST_PORT: z.coerce.number().int().positive().default(3143),
});

export type BenchEnv = z.infer<typeof envSchema>;

export function loadBenchEnv(source: NodeJS.ProcessEnv = process.env): BenchEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    console.error("Invalid corpus-bench environment configuration.");
    console.error(z.prettifyError(result.error));
    process.exit(1);
  }
  return result.data;
}
