#!/usr/bin/env node
import { passwordSchema } from "@mail/shared";
import { eq } from "drizzle-orm";
import { hashPassword } from "./auth/password.js";
import { revokeAllSessionsForUser } from "./auth/sessions.js";
import { deleteTotpCredential, getConfirmedTotpCredential } from "./auth/totp-credentials.js";
import { createDb } from "./db/client.js";
import { users } from "./db/schema.js";
import { loadEnv } from "./env.js";

const USAGE = "Usage: cli.js reset-owner-password <new-password> | disable-totp";

/**
 * Operator CLI: the PoC's only account-recovery path (poc-spec.md §Auth &
 * Users). Ships inside the app image so it reuses the real argon2id hasher
 * rather than hand-written SQL (ADR-0009 deployment) — run it with
 * `docker compose exec app node dist/cli.js <command>`.
 */
async function main(argv: string[]) {
  const [command, ...args] = argv;

  if (command !== "reset-owner-password" && command !== "disable-totp") {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  let newPassword: string | undefined;
  if (command === "reset-owner-password") {
    newPassword = args[0];
    const parsed = passwordSchema.safeParse(newPassword);
    if (!parsed.success) {
      console.error(parsed.error.issues.map((issue) => issue.message).join("\n"));
      process.exitCode = 1;
      return;
    }
    newPassword = parsed.data;
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

    if (command === "reset-owner-password") {
      if (!newPassword) {
        throw new Error("newPassword was validated above but is missing here.");
      }
      const passwordHash = await hashPassword(newPassword);
      await db
        .update(users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(users.id, owner.id));

      // A password reset is a "someone else may have this password" event —
      // every existing session, wherever it came from, stops being valid.
      await revokeAllSessionsForUser(db, owner.id);

      console.log(`Password reset for Owner "${owner.username}". All sessions revoked.`);
      return;
    }

    // disable-totp: the lost-authenticator recovery escape hatch (#32) —
    // there's no System Mailer flow yet, so this CLI is it.
    const totp = await getConfirmedTotpCredential(db, owner.id);
    if (!totp) {
      console.error(`Owner "${owner.username}" doesn't have TOTP enabled — nothing to disable.`);
      process.exitCode = 1;
      return;
    }
    await deleteTotpCredential(db, owner.id);
    console.log(`TOTP disabled for Owner "${owner.username}".`);
  } finally {
    await sql.end();
  }
}

await main(process.argv.slice(2));
