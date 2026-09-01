import { z } from "zod";

/**
 * Fail-closed config per ADR-0009: PUBLIC_URL and MAIL_CREDENTIAL_KEY have no
 * default and the process refuses to boot without them. MAIL_BIND defaults to
 * loopback so the safe case needs no thought.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PUBLIC_URL: z.url(),
  MAIL_CREDENTIAL_KEY: z.string().min(32, "MAIL_CREDENTIAL_KEY must be at least 32 bytes"),
  MAIL_BIND: z.string().default("127.0.0.1:3000"),
  DATABASE_URL: z.url(),
  /**
   * ADR-0012's instance-level attachment budget, in encoded (base64) bytes —
   * 25MB default, ~18MB of real files. Read once at boot and handed to
   * `routes/attachments.ts`/`routes/compose-config.ts`; never a per-User or
   * per-Mail-Account setting.
   */
  ATTACHMENT_BUDGET_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    console.error("Refusing to boot: invalid environment configuration.");
    console.error(z.prettifyError(result.error));
    process.exit(1);
  }
  return result.data;
}
