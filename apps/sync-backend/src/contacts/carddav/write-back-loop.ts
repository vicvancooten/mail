import { contactDisplayName } from "@mail/shared";
import type { FastifyBaseLogger } from "fastify";
import { listCarddavAddressBooksForConnectedAccount } from "../../address-books/store.js";
import {
  deriveCredentialKey,
  unsealPasswordCredential,
} from "../../connected-accounts/credential-crypto.js";
import { listActiveConnectedAccountsWithFacet } from "../../connected-accounts/store.js";
import type { Db } from "../../db/client.js";
import { type PollLoopHandle, startPollLoop } from "../../sync/poll-loop.js";
import { getContactPhotoBlob } from "../photo-store.js";
import { recordContactRollback } from "../rollback-store.js";
import {
  type ContactRow,
  confirmCarddavContactWrite,
  contactRowById,
  contactWritableFieldsFromRow,
  revertCarddavContactFields,
  revertContactPhoto,
} from "../store.js";
import {
  type ContactCarddavWriteBackRow,
  deleteCarddavWriteBack,
  listCarddavWriteBacksForAddressBook,
} from "../write-back-outbox.js";
import {
  type CarddavClient,
  type CarddavCredentials,
  CarddavWriteRejectedError,
  createCarddavClient,
} from "./client.js";
import { parseVcard, serializeVcard } from "./vcard.js";

/**
 * The write-back outbox's drain (#226, `db/schema.ts#contactCarddavWriteBacks`'s
 * own doc comment) — `contacts/google/write-back-loop.ts`'s own shape, on
 * its own short-interval schedule independent of the read-side sync loop
 * above, and its own "one write in flight per collection" discipline: each
 * Address Book's own queue drains sequentially, never fanned out, the same
 * reasoning Google's own loop gives for one Connected Account.
 *
 * **The first tick runs immediately**, same reasoning as every other loop
 * `poll-loop.ts` builds on.
 */

const DEFAULT_INTERVAL_MS = 5_000;

export interface CarddavContactsWriteBackLoopOptions {
  mailCredentialKey: string;
  client?: CarddavClient;
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export type CarddavContactsWriteBackLoopHandle = PollLoopHandle;

export function startCarddavContactsWriteBackLoop(
  db: Db,
  options: CarddavContactsWriteBackLoopOptions,
): CarddavContactsWriteBackLoopHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const logger = options.logger;
  const credentialKey = deriveCredentialKey(options.mailCredentialKey);
  const client = options.client ?? createCarddavClient();

  return startPollLoop({
    label: "carddav contacts write-back loop",
    intervalMs,
    logger,
    async tick({ isStopped }) {
      const accounts = await listActiveConnectedAccountsWithFacet(db, "caldav_carddav", "contacts");
      for (const account of accounts) {
        if (isStopped()) return;
        if (account.credential.kind !== "password" || !account.davUsername) continue;

        let credentials: CarddavCredentials;
        try {
          credentials = {
            username: account.davUsername,
            password: unsealPasswordCredential(
              account.credential,
              account.connectedAccountId,
              credentialKey,
            ),
          };
        } catch (err) {
          logger?.error(
            { err, connectedAccountId: account.connectedAccountId },
            "carddav contacts write-back loop: could not unseal credential",
          );
          continue;
        }

        const addressBooks = await listCarddavAddressBooksForConnectedAccount(
          db,
          account.connectedAccountId,
        );
        for (const addressBook of addressBooks) {
          if (isStopped()) return;
          if (!addressBook.carddavCollectionUrl) continue;
          const rows = await listCarddavWriteBacksForAddressBook(db, addressBook.id);
          if (rows.length === 0) continue;

          // Sequential, one row at a time, never `Promise.all` — this
          // file's own doc comment on why that's the whole point.
          for (const row of rows) {
            if (isStopped()) return;
            try {
              if (row.kind === "delete") {
                await drainDeleteWriteBack(db, client, credentials, row, logger);
              } else if (row.kind === "restore") {
                await drainRestoreWriteBack(
                  db,
                  client,
                  credentials,
                  addressBook.carddavCollectionUrl,
                  row,
                  logger,
                );
              } else {
                await drainMirroredWriteBack(
                  db,
                  client,
                  credentials,
                  addressBook.carddavCollectionUrl,
                  row,
                  logger,
                );
              }
            } catch (err) {
              // One row's own failure never stops the rest of this
              // collection's queue — `google/write-back-loop.ts`'s own
              // per-row isolation.
              logger?.error(
                { err, contactId: row.contactId, kind: row.kind },
                "carddav contacts write-back loop: row failed unexpectedly",
              );
            }
          }
        }
      }
    },
  });
}

/** Both `"fields"` and `"photo"` push the *whole* current vCard — `serializeVcard` always regenerates every modelled property together (`vcard.ts`'s own doc comment) — differing only in what a rejection rolls back: a `"fields"` row has no photo snapshot to revert (this edit never touched the photo), a `"photo"` row reverts `previousPhoto` and leaves the field edit that may have landed since untouched. */
async function drainMirroredWriteBack(
  db: Db,
  client: CarddavClient,
  credentials: CarddavCredentials,
  collectionUrl: string,
  row: ContactCarddavWriteBackRow,
  logger: FastifyBaseLogger | undefined,
): Promise<void> {
  const contact = await contactRowById(db, row.contactId);
  if (!contact) {
    // Deleted, or unmirrored, since this was queued — nothing left to write
    // through, the same tolerance `drainProtocolWrites` gives a Message
    // that's since been expunged.
    await deleteCarddavWriteBack(db, row.id);
    return;
  }

  try {
    const data = await buildCurrentVcard(db, contact);
    const written = contact.carddavHref
      ? await pushUpdate(client, credentials, contact.carddavHref, contact.carddavEtag, data)
      : await pushCreate(client, credentials, collectionUrl, contact.id, data);
    const confirmed = await client.multiget({
      url: collectionUrl,
      hrefs: [written.href],
      credentials,
    });
    await confirmCarddavContactWrite(db, contact.id, {
      href: written.href,
      etag: confirmed[0]?.etag ?? written.etag,
      rawVcard: confirmed[0]?.data ?? data,
    });
    await deleteCarddavWriteBack(db, row.id);
  } catch (err) {
    if (!(err instanceof CarddavWriteRejectedError)) throw err; // transient — leave queued for the next tick
    if (row.kind === "photo") {
      await revertContactPhoto(db, contact.id, row.previousPhoto);
    } else {
      await revertCarddavContactFields(db, contact);
    }
    await recordContactRollback(db, {
      userId: contact.userId,
      contactId: contact.id,
      contactName: contactDisplayName(contactWritableFieldsFromRow(contact)),
      reason: rollbackReason(err),
    });
    await deleteCarddavWriteBack(db, row.id);
    logger?.warn(
      { contactId: contact.id, reason: err.reason },
      "carddav contacts write-back loop: write rejected, mirror reverted",
    );
  }
}

/**
 * The "delete" write-back's own drain (#226, `trashContact`) — removes the
 * server's copy at once, using the `carddavHref` captured at enqueue time
 * (the Contact row's own copy is already null by the time this runs,
 * ADR-0029). Unconditional (no `If-Match`) — `contact_carddav_write_backs`
 * captures no etag to compare against, the same posture Google's own delete
 * push already takes (`client.ts`'s own `deleteVCard` still passes an empty
 * etag, which `tsdav` drops from the request entirely rather than sending a
 * conditional header that could never match). A 404 (already gone upstream)
 * is exactly as much "nothing left to do" as a genuinely missing row would
 * be; only a non-4xx error (a network blip) leaves this queued.
 */
async function drainDeleteWriteBack(
  db: Db,
  client: CarddavClient,
  credentials: CarddavCredentials,
  row: ContactCarddavWriteBackRow,
  logger: FastifyBaseLogger | undefined,
): Promise<void> {
  if (row.carddavHref) {
    try {
      await client.deleteVCard({ url: row.carddavHref, etag: "", credentials });
    } catch (err) {
      if (!(err instanceof CarddavWriteRejectedError)) throw err;
      logger?.warn(
        { contactId: row.contactId, reason: err.reason },
        "carddav contacts write-back loop: delete rejected, treating as already gone",
      );
    }
  }
  await deleteCarddavWriteBack(db, row.id);
}

/**
 * The "restore" write-back's own drain (#226, `restoreContact`) — a fresh
 * `PUT` with `If-None-Match: *` to a brand-new href, never a reactivation of
 * the old one (ADR-0029: there is nothing left to reactivate) —
 * `google/write-back-loop.ts#drainRestoreWriteBack`'s own shape.
 */
async function drainRestoreWriteBack(
  db: Db,
  client: CarddavClient,
  credentials: CarddavCredentials,
  collectionUrl: string,
  row: ContactCarddavWriteBackRow,
  logger: FastifyBaseLogger | undefined,
): Promise<void> {
  const contact = await contactRowById(db, row.contactId);
  if (!contact || contact.carddavHref) {
    // Already re-mirrored by a race, or gone entirely — nothing left to
    // create.
    await deleteCarddavWriteBack(db, row.id);
    return;
  }

  try {
    const data = await buildCurrentVcard(db, contact);
    const created = await pushCreate(client, credentials, collectionUrl, contact.id, data);
    const confirmed = await client.multiget({
      url: collectionUrl,
      hrefs: [created.href],
      credentials,
    });
    await confirmCarddavContactWrite(db, contact.id, {
      href: created.href,
      etag: confirmed[0]?.etag ?? created.etag,
      rawVcard: confirmed[0]?.data ?? data,
    });
  } catch (err) {
    if (!(err instanceof CarddavWriteRejectedError)) throw err;
    // A rejected create has nothing to revert (the mirror was never set) —
    // dequeued the same "definitive rejection ends the row" way
    // `drainMirroredWriteBack` treats its own, leaving the Contact Local in
    // practice rather than looping forever.
    logger?.warn(
      { contactId: contact.id, reason: err.reason },
      "carddav contacts write-back loop: restore create rejected, Contact stays unmirrored",
    );
  }
  await deleteCarddavWriteBack(db, row.id);
}

/** The Contact's *current* fields/categories/photo, re-serialised into its last raw vCard (or a brand-new one) — `contactWritableFieldsFromRow`'s own "read fresh, never a captured snapshot" doc comment. */
async function buildCurrentVcard(db: Db, contact: ContactRow): Promise<string> {
  const photo = contact.photo ? await getContactPhotoBlob(db, contact.userId, contact.id) : null;
  const uid = (contact.carddavRawVcard && parseVcard(contact.carddavRawVcard).uid) || contact.id;
  return serializeVcard({
    previousRawVcard: contact.carddavRawVcard,
    fields: contactWritableFieldsFromRow(contact),
    categories: contact.categories,
    photo: photo ? { mimeType: photo.mimeType, base64: photo.bytes.toString("base64") } : null,
    uid,
  });
}

async function pushUpdate(
  client: CarddavClient,
  credentials: CarddavCredentials,
  href: string,
  etag: string | null,
  data: string,
): Promise<{ href: string; etag: string | undefined }> {
  const result = await client.updateVCard({ url: href, etag: etag ?? "", data, credentials });
  return { href, etag: result.etag };
}

async function pushCreate(
  client: CarddavClient,
  credentials: CarddavCredentials,
  collectionUrl: string,
  contactId: string,
  data: string,
): Promise<{ href: string; etag: string | undefined }> {
  return client.createVCard({
    collectionUrl,
    filename: `${contactId}.vcf`,
    data,
    credentials,
  });
}

function rollbackReason(
  err: CarddavWriteRejectedError,
): "carddav_conflict" | "carddav_not_found" | "carddav_rejected" {
  if (err.reason === "conflict") return "carddav_conflict";
  if (err.reason === "not_found") return "carddav_not_found";
  return "carddav_rejected";
}
