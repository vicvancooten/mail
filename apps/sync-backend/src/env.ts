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
