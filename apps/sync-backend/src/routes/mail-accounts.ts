import { randomUUID } from "node:crypto";
import {
  createMailAccountRequestSchema,
  discoverMailAccountRequestSchema,
  discoverMailAccountResponseSchema,
  mailAccountListResponseSchema,
  mailAccountResponseSchema,
  reauthMailAccountRequestSchema,
} from "@mail/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { discoverMailAccount } from "../mail-accounts/autodiscover.js";
import { deriveCredentialKey, sealPasswordCredential } from "../mail-accounts/credential-crypto.js";
import {
  getMailAccountForUser,
  insertMailAccount,
  listMailAccountsForUser,
  replaceMailAccountCredential,
  toWireMailAccount,
} from "../mail-accounts/store.js";
import { verifyMailAccountCredentials } from "../mail-accounts/verify.js";
import { noopSyncManager, type SyncManager } from "../sync/manager.js";

export interface MailAccountRoutesOptions {
  db: Db;
  /** `env.MAIL_CREDENTIAL_KEY` — kept as the raw string, hashed to a key per seal/unseal call. */
  mailCredentialKey: string;
  /** Overridable in tests: GreenMail (docs/dev-setup.md) accepts any password, so exercising a
   * rejection needs a stub rather than a real IMAP/SMTP server. */
  verify?: typeof verifyMailAccountCredentials;
  discover?: typeof discoverMailAccount;
  /** Starts a session on create, restarts one on reauth (#35). Defaults to a no-op — see `app.ts`. */
  syncManager?: SyncManager;
}

export async function mailAccountRoutes(
  app: FastifyInstance,
  {
    db,
    mailCredentialKey,
    verify = verifyMailAccountCredentials,
    discover = discoverMailAccount,
    syncManager = noopSyncManager,
  }: MailAccountRoutesOptions,
) {
  const key = deriveCredentialKey(mailCredentialKey);

  app.post("/mail-accounts/discover", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = discoverMailAccountRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }
    const result = await discover(body.data.emailAddress);
    return discoverMailAccountResponseSchema.parse(result);
  });

  app.get("/mail-accounts", { preHandler: app.requireAuth }, async (request) => {
    const rows = await listMailAccountsForUser(db, requireUser(request).id);
    return mailAccountListResponseSchema.parse({ mailAccounts: rows.map(toWireMailAccount) });
  });

  // Verify-before-save (poc-spec.md §Mail Accounts): never writes a row
  // unless a live IMAP+SMTP check with these exact credentials succeeds.
  app.post("/mail-accounts", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = createMailAccountRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }
    const { emailAddress, imap, smtp, username, password } = body.data;

    const result = await verify({ imap, smtp, username, password });
    if (!result.ok) {
      return reply
        .code(result.reason === "credentials_rejected" ? 422 : 502)
        .send({ error: result.reason, detail: result.detail });
    }

    const id = randomUUID();
    const row = await insertMailAccount(db, {
      id,
      userId: requireUser(request).id,
      emailAddress,
      imap,
      smtp,
      username,
      credential: sealPasswordCredential(password, id, key),
    });
    syncManager.start(row);
    return reply
      .code(201)
      .send(mailAccountResponseSchema.parse({ mailAccount: toWireMailAccount(row) }));
  });

  // The Needs Reauth re-enter-credentials flow (CONTEXT.md): re-verifies
  // against the account's existing host/port/TLS config and, on success,
  // resumes it (status back to `active`) regardless of what state it was in.
  app.post("/mail-accounts/:id/reauth", { preHandler: app.requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await getMailAccountForUser(db, requireUser(request).id, id);
    if (!row) {
      return reply.code(404).send({ error: "not_found" });
    }

    const body = reauthMailAccountRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }
    const { username, password } = body.data;

    const imap = { host: row.imapHost, port: row.imapPort, security: row.imapSecurity };
    const smtp = { host: row.smtpHost, port: row.smtpPort, security: row.smtpSecurity };
    const result = await verify({ imap, smtp, username, password });
    if (!result.ok) {
      return reply
        .code(result.reason === "credentials_rejected" ? 422 : 502)
        .send({ error: result.reason, detail: result.detail });
    }

    await replaceMailAccountCredential(db, id, username, sealPasswordCredential(password, id, key));
    const updated = await getMailAccountForUser(db, requireUser(request).id, id);
    if (!updated) {
      throw new Error("Mail Account disappeared between reauth update and re-read.");
    }
    // Resumes syncing (#35): a Needs-Reauth account's session has already
    // stopped itself for good, so re-entering credentials is the only thing
    // that starts a fresh one.
    await syncManager.restart(id);
    return mailAccountResponseSchema.parse({ mailAccount: toWireMailAccount(updated) });
  });
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
