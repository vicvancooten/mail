import { messageSchema, threadMessagesResponseSchema } from "@mail/shared";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ImapFlow } from "imapflow";
import type { Db } from "../db/client.js";
import { folders, type MessageAddress, type MessageAttachment, messages } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import { getMailAccountById, getMailAccountForUser } from "../mail-accounts/store.js";
import { fetchMessageBody, storeMessageBody } from "../sync/bodies.js";
import { readBodyParts } from "../sync/body-structure.js";
import {
  deriveImageProxyKey,
  fetchProxiedImage,
  ImageProxyError,
  rewriteRemoteImageReferences,
  verifyImageProxySignature,
} from "../sync/image-proxy.js";
import { withMailAccountConnection } from "../sync/imap-connection.js";

export interface MessageRoutesOptions {
  db: Db;
  mailCredentialKey: string;
}

type MessageRow = typeof messages.$inferSelect;

/**
 * Per-message and per-Thread reads (#41). Deliberately not part of
 * `POST /sync` (ADR-0011): a Message has no delta protocol at PoC scope —
 * `GET /threads/:threadId/messages` is a plain fetch-through read, cached
 * only by whatever the Client's own request layer decides to keep, the same
 * "no received-attachment caching" posture `poc-spec.md` §Compose states for
 * attachments applies here to bodies that outrun the sweep (below) and to
 * every attachment byte this file ever serves.
 */
export async function messageRoutes(
  app: FastifyInstance,
  { db, mailCredentialKey }: MessageRoutesOptions,
) {
  const credentialKey = deriveCredentialKey(mailCredentialKey);
  const imageProxyKey = deriveImageProxyKey(mailCredentialKey);

  app.get(
    "/threads/:threadId/messages",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { threadId } = request.params as { threadId: string };
      const userId = requireUser(request).id;

      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.threadId, threadId))
        .orderBy(asc(messages.sentAt));
      if (rows.length === 0) {
        return reply.code(404).send({ error: "not_found" });
      }

      const mailAccountId = rows[0]?.mailAccountId;
      const account = mailAccountId ? await getMailAccountForUser(db, userId, mailAccountId) : null;
      if (!account) {
        return reply.code(404).send({ error: "not_found" });
      }

      const resolved = await resolvePendingBodies(db, account.id, rows, credentialKey);

      return threadMessagesResponseSchema.parse({
        messages: resolved.map((row) => toWireMessage(row, imageProxyKey)),
      });
    },
  );

  app.get(
    "/messages/:messageId/attachments/:part",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { messageId, part } = request.params as { messageId: string; part: string };
      const userId = requireUser(request).id;

      const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
      if (!row) return reply.code(404).send({ error: "not_found" });
      const account = await getMailAccountForUser(db, userId, row.mailAccountId);
      if (!account) return reply.code(404).send({ error: "not_found" });

      const attachment = row.attachments.find((candidate) => candidate.part === part);
      if (!attachment) return reply.code(404).send({ error: "not_found" });

      const [folder] = await db.select().from(folders).where(eq(folders.id, row.folderId)).limit(1);
      if (!folder) return reply.code(404).send({ error: "not_found" });

      const bytes = await withMailAccountConnection(
        db,
        account,
        { credentialKey },
        async (client) => {
          const lock = await client.getMailboxLock(folder.path, { readOnly: true });
          try {
            return await fetchAttachmentBytes(client, row.uid, attachment);
          } finally {
            lock.release();
          }
        },
      );

      const filename = attachment.filename ?? "attachment";
      reply
        .header("Content-Type", attachment.mimeType)
        .header("Content-Disposition", `inline; filename="${sanitizeFilename(filename)}"`)
        // Fetch-through, never cached server-side — `poc-spec.md` §Compose's
        // "no received-attachment caching" applies to every read of this
        // route, not only the composer's. A short private cache keeps a
        // single render (body + preview both requesting the same part) from
        // opening the IMAP connection twice.
        .header("Cache-Control", "private, max-age=60");
      return reply.send(bytes);
    },
  );

  app.get(
    "/messages/:messageId/image-proxy",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { messageId } = request.params as { messageId: string };
      const userId = requireUser(request).id;
      const query = request.query as { url?: string; sig?: string };

      if (!query.url || !query.sig) {
        return reply.code(400).send({ error: "invalid_request" });
      }

      const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
      if (!row) return reply.code(404).send({ error: "not_found" });
      const account = await getMailAccountForUser(db, userId, row.mailAccountId);
      if (!account) return reply.code(404).send({ error: "not_found" });

      if (!verifyImageProxySignature(imageProxyKey, messageId, query.url, query.sig)) {
        return reply.code(403).send({ error: "invalid_signature" });
      }

      try {
        const image = await fetchProxiedImage(query.url);
        reply
          .header("Content-Type", image.contentType)
          // Far-future and private: the URL already carries the sender's
          // original address plus a signature over it, so it is effectively
          // content-addressed — nothing about this response ever changes for
          // the same query string (`docs/research/0005` §3).
          .header("Cache-Control", "private, max-age=604800, immutable");
        return reply.send(image.body);
      } catch (err) {
        if (err instanceof ImageProxyError) {
          return reply.code(imageProxyStatus(err.code)).send({ error: err.code });
        }
        throw err;
      }
    },
  );
}

function imageProxyStatus(code: ImageProxyError["code"]): number {
  switch (code) {
    case "invalid_url":
      return 400;
    case "disallowed_scheme":
    case "disallowed_address":
      return 403;
    case "too_large":
      return 413;
    case "timeout":
      return 504;
    case "upstream_error":
      return 502;
  }
}

/**
 * Fetch-through for a body still behind the Index Watermark (#36's sweep
 * hasn't reached it yet, or never will for an account with sweeping still in
 * progress): opens one connection, groups by Folder exactly like
 * `sync/body-sweep.ts`'s own batch does, and stores the result so the sweep
 * finds nothing left to do for these messages later. Rows already carrying a
 * body pass through untouched — the common case, and the only one the
 * `<100ms` open bar has to hold for.
 */
async function resolvePendingBodies(
  db: Db,
  mailAccountId: string,
  rows: MessageRow[],
  credentialKey: Buffer,
): Promise<MessageRow[]> {
  const pending = rows.filter((row) => row.bodyFetchedAt === null);
  if (pending.length === 0) return rows;

  const account = await getMailAccountById(db, mailAccountId);
  if (!account) return rows; // deleted mid-request — the caller's own ownership check already ran

  const byFolder = new Map<string, MessageRow[]>();
  for (const row of pending) {
    const bucket = byFolder.get(row.folderId);
    if (bucket) bucket.push(row);
    else byFolder.set(row.folderId, [row]);
  }

  const patched = new Map<string, MessageRow>();
  await withMailAccountConnection(db, account, { credentialKey }, async (client) => {
    for (const [folderId, folderRows] of byFolder) {
      const [folder] = await db.select().from(folders).where(eq(folders.id, folderId)).limit(1);
      if (!folder) continue;

      const lock = await client.getMailboxLock(folder.path, { readOnly: true });
      try {
        const fetched = await client.fetchAll(
          folderRows.map((row) => row.uid),
          { uid: true, bodyStructure: true },
          { uid: true },
        );
        const byUid = new Map(fetched.map((message) => [message.uid, message]));
        for (const row of folderRows) {
          const structure = byUid.get(row.uid);
          if (!structure) continue; // vanished server-side since the SELECT — the next delta reconciles it
          const parts = readBodyParts(structure.bodyStructure);
          const body = await fetchMessageBody(client, row.uid, parts);
          await storeMessageBody(db, row.id, body);
          patched.set(row.id, {
            ...row,
            bodyText: body.text,
            bodyHtml: body.html,
            bodyFetchedAt: new Date(),
          });
        }
      } finally {
        lock.release();
      }
    }
  });

  return rows.map((row) => patched.get(row.id) ?? row);
}

function toWireMessage(row: MessageRow, imageProxyKey: Buffer) {
  return messageSchema.parse({
    id: row.id,
    threadId: row.threadId,
    mailAccountId: row.mailAccountId,
    messageIdHeader: row.messageIdHeader,
    references: row.references,
    subject: row.subject,
    from: toAddress(row.fromName, row.fromAddress),
    to: row.toAddresses,
    cc: row.ccAddresses,
    replyTo: row.replyToAddresses,
    sentAt: row.sentAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    seen: row.seen,
    flagged: row.flagged,
    // Every attachment, cid:-only inline parts included: the Client needs a
    // part id for *every* Content-ID the body might reference (§4) to
    // resolve `cid:` to a `blob:` URL, not only the ones worth a download
    // entry. `isRealAttachment` is what the attachment panel filters
    // through — that is a rendering concern, not a wire-shape one.
    attachments: row.attachments,
    bodyText: row.bodyText,
    bodyHtml:
      row.bodyHtml === null
        ? null
        : rewriteRemoteImageReferences(row.bodyHtml, { messageId: row.id, key: imageProxyKey }),
  });
}

function toAddress(name: string | null, address: string | null): MessageAddress | null {
  return address ? { name, address } : null;
}

/** Strips characters that would break out of the quoted `Content-Disposition` filename param. */
function sanitizeFilename(filename: string): string {
  return filename.replace(/["\r\n]/g, "");
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}

/**
 * Downloads one attachment part's **raw** bytes via `fetchOne`'s
 * `bodyParts` query — not `ImapFlow#download()` — and decodes them against
 * the `Content-Transfer-Encoding` `sync/body-structure.ts` already captured
 * from BODYSTRUCTURE at ingest. `download()`'s own encoding detection reads
 * it from a second, companion `BODY[<part>.MIME]` FETCH at download time,
 * and that lookup was found to come back empty for a nested (dotted) part id
 * against GreenMail — silently handing back still-base64-encoded bytes
 * instead of decoding them. Trusting the value ingest already parsed
 * correctly (and proved against the same BODYSTRUCTURE) sidesteps that
 * second, unreliable FETCH entirely.
 */
async function fetchAttachmentBytes(
  client: ImapFlow,
  uid: number,
  attachment: MessageAttachment,
): Promise<Buffer> {
  const response = await client.fetchOne(
    String(uid),
    { uid: true, bodyParts: [attachment.part] },
    { uid: true },
  );
  const raw = response ? response.bodyParts?.get(attachment.part) : undefined;
  if (!raw) return Buffer.alloc(0);
  return decodeTransferEncoding(raw, attachment.encoding);
}

export function decodeTransferEncoding(raw: Buffer, encoding: string | null): Buffer {
  switch (encoding) {
    case "base64":
      return Buffer.from(raw.toString("ascii").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
    case "quoted-printable":
      return decodeQuotedPrintable(raw.toString("ascii"));
    default:
      // `7bit`/`8bit`/`binary`/unset: already the real bytes.
      return raw;
  }
}

/** RFC 2045 §6.7: `=XX` hex-escapes a byte, `=` at end-of-line is a soft break (removed, not a byte). */
export function decodeQuotedPrintable(input: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "=") {
      if (input[i + 1] === "\r" && input[i + 2] === "\n") {
        i += 2;
        continue;
      }
      if (input[i + 1] === "\n") {
        i += 1;
        continue;
      }
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push((ch ?? "").charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}
