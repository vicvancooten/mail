import { contactDisplayName } from "@mail/shared";
import type { FastifyBaseLogger } from "fastify";
import {
  deriveCredentialKey,
  unsealOAuthAccessToken,
} from "../../connected-accounts/credential-crypto.js";
import { listActiveConnectedAccountsWithFacet } from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { type PollLoopHandle, startPollLoop } from "../../sync/poll-loop.js";
import { getContactPhotoBlob } from "../photo-store.js";
import { recordContactRollback } from "../rollback-store.js";
import {
  confirmGoogleContactCreate,
  confirmGoogleContactWrite,
  contactRowById,
  contactWritableFieldsFromRow,
  revertContactPhoto,
  revertGoogleContactFields,
} from "../store.js";
import {
  type ContactGoogleWriteBackRow,
  deleteWriteBack,
  listWriteBacksForConnectedAccount,
} from "../write-back-outbox.js";
import {
  createGooglePeopleClient,
  GoogleContactWriteRejectedError,
  type GooglePeopleClient,
} from "./client.js";
import { buildGooglePersonCreateBody, buildGooglePersonPatch } from "./mapping.js";
import { GOOGLE_PERSON_FIELDS } from "./people-sync.js";

/**
 * The write-back outbox's drain (#216, `db/schema.ts#contactGoogleWriteBacks`'s
 * own doc comment) — `sync/protocol-writes.ts`'s own shape, on its own
 * short-interval schedule (an edit should reach Google in seconds, not on
 * the read side's 15-minute cadence, `google/poll-loop.ts`) and its own
 * strict "one write in flight per Connected Account" discipline (research
 * doc §1.6: "Mutate requests for the same user should be sent
 * sequentially"), which this gives simply by `await`ing each row before
 * starting the next rather than fanning a `Promise.all` across a queue.
 *
 * **The first tick runs immediately**, the same reasoning
 * `google/poll-loop.ts`/`grant-refresh-loop.ts` already give: an edit queued
 * while the process was down shouldn't wait out a full interval once it
 * comes back.
 */

const DEFAULT_INTERVAL_MS = 5_000;

export interface GoogleContactsWriteBackLoopOptions {
  mailCredentialKey: string;
  client?: GooglePeopleClient;
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export type GoogleContactsWriteBackLoopHandle = PollLoopHandle;

export function startGoogleContactsWriteBackLoop(
  db: Db,
  options: GoogleContactsWriteBackLoopOptions,
): GoogleContactsWriteBackLoopHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const logger = options.logger;
  const credentialKey = deriveCredentialKey(options.mailCredentialKey);
  const client = options.client ?? createGooglePeopleClient();

  return startPollLoop({
    label: "google contacts write-back loop",
    intervalMs,
    logger,
    async tick({ isStopped }) {
      const accounts = await listActiveConnectedAccountsWithFacet(db, "google", "contacts");
      for (const account of accounts) {
        if (isStopped()) return;
        if (account.credential.kind !== "oauth") continue;

        const rows = await listWriteBacksForConnectedAccount(db, account.connectedAccountId);
        if (rows.length === 0) continue;

        let accessToken: string;
        try {
          accessToken = unsealOAuthAccessToken(
            account.credential,
            "default",
            account.connectedAccountId,
            credentialKey,
          );
        } catch (err) {
          logger?.error(
            { err, connectedAccountId: account.connectedAccountId },
            "google contacts write-back loop: could not unseal access token",
          );
          continue;
        }

        // Sequential, one row at a time, never `Promise.all` — see this
        // file's own doc comment on why that's the whole point.
        for (const row of rows) {
          if (isStopped()) return;
          try {
            if (row.kind === "fields") {
              await drainFieldsWriteBack(db, client, accessToken, row, logger);
            } else if (row.kind === "photo") {
              await drainPhotoWriteBack(db, client, accessToken, row, logger);
            } else if (row.kind === "delete") {
              await drainDeleteWriteBack(db, client, accessToken, row, logger);
            } else {
              await drainRestoreWriteBack(db, client, accessToken, row, logger);
            }
          } catch (err) {
            // One row's own failure (a network error the `catch` blocks
            // below didn't already handle) never stops the rest of this
            // account's queue — the same per-row isolation
            // `drainProtocolWrites` already gives Mail's own outbox.
            logger?.error(
              { err, contactId: row.contactId, kind: row.kind },
              "google contacts write-back loop: row failed unexpectedly",
            );
          }
        }
      }
    },
  });
}

async function drainFieldsWriteBack(
  db: Db,
  client: GooglePeopleClient,
  accessToken: string,
  row: ContactGoogleWriteBackRow,
  logger: FastifyBaseLogger | undefined,
): Promise<void> {
  const contact = await contactRowById(db, row.contactId);
  if (!contact?.googleResourceName) {
    // Deleted, or unmirrored, since this was queued — nothing left to write
    // through, the same tolerance `drainProtocolWrites` gives a Message
    // that's since been expunged.
    await deleteWriteBack(db, row.id);
    return;
  }

  const patch = buildGooglePersonPatch({
    fields: contactWritableFieldsFromRow(contact),
    priorPayload: contact.googlePayload ?? {},
    resourceName: contact.googleResourceName,
    etag: contact.googleEtag ?? "",
  });

  try {
    const person = await client.updateContact(accessToken, {
      resourceName: contact.googleResourceName,
      updatePersonFields: patch.updatePersonFields,
      personFields: GOOGLE_PERSON_FIELDS,
      body: patch.body,
    });
    await confirmGoogleContactWrite(db, contact.id, person);
    await deleteWriteBack(db, row.id);
  } catch (err) {
    if (!(err instanceof GoogleContactWriteRejectedError)) throw err; // transient — leave queued for the next tick
    await revertGoogleContactFields(db, contact);
    await recordContactRollback(db, {
      userId: contact.userId,
      contactId: contact.id,
      contactName: contactDisplayName(contactWritableFieldsFromRow(contact)),
      reason: rollbackReason(err),
    });
    await deleteWriteBack(db, row.id);
    logger?.warn(
      { contactId: contact.id, reason: err.reason },
      "google contacts write-back loop: field write rejected, mirror reverted",
    );
  }
}

async function drainPhotoWriteBack(
  db: Db,
  client: GooglePeopleClient,
  accessToken: string,
  row: ContactGoogleWriteBackRow,
  logger: FastifyBaseLogger | undefined,
): Promise<void> {
  const contact = await contactRowById(db, row.contactId);
  if (!contact?.googleResourceName) {
    await deleteWriteBack(db, row.id);
    return;
  }

  try {
    if (contact.photo) {
      const blob = await getContactPhotoBlob(db, contact.userId, contact.id);
      if (!blob) {
        // The Contact's own `photo` reference names a blob that's already
        // gone (a race with a later remove) — nothing left to upload.
        await deleteWriteBack(db, row.id);
        return;
      }
      await client.updateContactPhoto(
        accessToken,
        contact.googleResourceName,
        blob.bytes.toString("base64"),
      );
    } else {
      await client.deleteContactPhoto(accessToken, contact.googleResourceName);
    }
    await deleteWriteBack(db, row.id);
  } catch (err) {
    if (!(err instanceof GoogleContactWriteRejectedError)) throw err;
    await revertContactPhoto(db, contact.id, row.previousPhoto);
    await recordContactRollback(db, {
      userId: contact.userId,
      contactId: contact.id,
      contactName: contactDisplayName(contactWritableFieldsFromRow(contact)),
      reason: rollbackReason(err),
    });
    await deleteWriteBack(db, row.id);
    logger?.warn(
      { contactId: contact.id, reason: err.reason },
      "google contacts write-back loop: photo write rejected, mirror reverted",
    );
  }
}

/**
 * The "delete" write-back's own drain (#224, `trashContact`) — removes
 * Google's copy at once, using the `googleResourceName` captured at enqueue
 * time (the Contact row's own copy is already null by the time this runs,
 * ADR-0029). No rollback: a delete is a confirmed act, not an Optimistic
 * Action's edit — there is no "upstream wins" to revert *to*, and Wicket's
 * own row is a soft-deleted Recently Deleted entry either way. A 404 (already
 * gone upstream) is exactly as much "nothing left to do" as a genuinely
 * missing row would be, so it dequeues the same as a transient failure
 * doesn't — only a non-4xx error (a network blip) leaves this queued for the
 * next tick, via the same rethrow every other branch here relies on.
 */
async function drainDeleteWriteBack(
  db: Db,
  client: GooglePeopleClient,
  accessToken: string,
  row: ContactGoogleWriteBackRow,
  logger: FastifyBaseLogger | undefined,
): Promise<void> {
  if (!row.googleResourceName) {
    await deleteWriteBack(db, row.id);
    return;
  }
  try {
    await client.deleteContact(accessToken, row.googleResourceName);
  } catch (err) {
    if (!(err instanceof GoogleContactWriteRejectedError)) throw err;
    logger?.warn(
      { contactId: row.contactId, reason: err.reason },
      "google contacts write-back loop: delete rejected, treating as already gone",
    );
  }
  await deleteWriteBack(db, row.id);
}

/**
 * The "restore" write-back's own drain (#224, `restoreContact`) — a fresh
 * `people:createContact`, never a reactivation of the old resourceName
 * (ADR-0029: there is nothing left to reactivate). `contact.googleResourceName`
 * already being set is the one case worth skipping outright: a race that
 * already gave this Contact a mirror identity since this row was queued,
 * so creating a second upstream Person would orphan one of them.
 */
async function drainRestoreWriteBack(
  db: Db,
  client: GooglePeopleClient,
  accessToken: string,
  row: ContactGoogleWriteBackRow,
  logger: FastifyBaseLogger | undefined,
): Promise<void> {
  const contact = await contactRowById(db, row.contactId);
  if (!contact || contact.googleResourceName) {
    await deleteWriteBack(db, row.id);
    return;
  }

  const body = buildGooglePersonCreateBody(contactWritableFieldsFromRow(contact));
  try {
    const person = await client.createContact(accessToken, {
      personFields: GOOGLE_PERSON_FIELDS,
      body,
    });
    await confirmGoogleContactCreate(db, contact.id, person);
    await deleteWriteBack(db, row.id);
  } catch (err) {
    if (!(err instanceof GoogleContactWriteRejectedError)) throw err; // transient — leave queued for the next tick
    // A rejected create has nothing to revert (the mirror was never set) and,
    // unlike a transient failure, retrying the same body would only reject
    // again — dequeued the same "definitive rejection ends the row" way
    // `drainFieldsWriteBack` treats its own, leaving the Contact Local in
    // practice rather than looping forever.
    await deleteWriteBack(db, row.id);
    logger?.warn(
      { contactId: contact.id, reason: err.reason },
      "google contacts write-back loop: restore create rejected, Contact stays unmirrored",
    );
  }
}

function rollbackReason(
  err: GoogleContactWriteRejectedError,
): "google_conflict" | "google_not_found" | "google_rejected" {
  if (err.reason === "conflict") return "google_conflict";
  if (err.reason === "not_found") return "google_not_found";
  return "google_rejected";
}
