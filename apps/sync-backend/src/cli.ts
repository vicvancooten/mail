#!/usr/bin/env node
import { passwordSchema } from "@mail/shared";
import { eq } from "drizzle-orm";
import { hashPassword } from "./auth/password.js";
import { revokeAllSessionsForUser } from "./auth/sessions.js";
import { createDb } from "./db/client.js";
import { users } from "./db/schema.js";
import { loadEnv } from "./env.js";

/**
 * Operator CLI: the PoC's only account-recovery path (poc-spec.md §Auth &
 * Users). Ships inside the app image so it reuses the real argon2id hasher
 * rather than hand-written SQL (ADR-0009 deployment) — run it with
 * `docker compose exec app node dist/cli.js reset-owner-password <password>`.
 */
async function main(argv: string[]) {
  const [command, ...args] = argv;

  if (command !== "reset-owner-password") {
    console.error("Usage: cli.js reset-owner-password <new-password>");
    process.exitCode = 1;
    return;
  }

  const [newPassword] = args;
  const parsed = passwordSchema.safeParse(newPassword);
  if (!parsed.success) {
    console.error(parsed.error.issues.map((issue) => issue.message).join("\n"));
    process.exitCode = 1;
    return;
  }

  const env = loadEnv();
  const { db, sql } = createDb(env);

  try {
    const [owner] = await db.select().from(users).where(eq(users.role, "owner")).limit(1);
    if (!owner) {
      console.error("No Owner has claimed this instance yet — there is nothing to reset.");
      process.exitCode = 1;
      return;
    }

    const passwordHash = await hashPassword(parsed.data);
    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, owner.id));

    // A password reset is a "someone else may have this password" event —
    // every existing session, wherever it came from, stops being valid.
    await revokeAllSessionsForUser(db, owner.id);

    console.log(`Password reset for Owner "${owner.username}". All sessions revoked.`);
  } finally {
    await sql.end();
  }
}

await main(process.argv.slice(2));
