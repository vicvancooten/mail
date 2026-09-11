import {
  mirrorAddressBookResponseSchema,
  unmirrorAddressBookImpactResponseSchema,
  unmirrorAddressBookResponseSchema,
} from "@mail/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  AddressBookNotFoundError,
  AddressBookNotMirrorableError,
  mirrorAddressBook,
  toWireAddressBook,
  unmirrorAddressBook,
  unmirrorAddressBookImpact,
} from "../address-books/store.js";
import type { Db } from "../db/client.js";

export interface AddressBookRoutesOptions {
  db: Db;
}

/**
 * The `mirrored` checklist's write side (#215), the same three-plain-REST-
 * routes shape the sibling Calendar epic's `routes/calendars.ts` already
 * established rather than a `UserMutationIntent` on the ordinary sync
 * queue — the ticket's own acceptance line, "not an Optimistic Action": a
 * User needs the actual discarded counts back before they can even show the
 * confirm dialog, and unmirroring itself must run synchronously, once,
 * never replayed from an offline queue. The Address Book row itself still
 * rides the ordinary `AddressBook` collection sync afterward (its `syncRev`
 * bump fires the same `notify_sync_hint` trigger any other write does) —
 * these routes only ever hand back a snapshot for the request that made the
 * change.
 */
export async function addressBookRoutes(app: FastifyInstance, { db }: AddressBookRoutesOptions) {
  app.get(
    "/address-books/:id/unmirror-impact",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const discarded = await unmirrorAddressBookImpact(db, requireUser(request).id, id);
        return unmirrorAddressBookImpactResponseSchema.parse({ discarded });
      } catch (err) {
        return replyForAddressBookError(err, reply);
      }
    },
  );

  app.post(
    "/address-books/:id/unmirror",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const { addressBook, discarded } = await unmirrorAddressBook(
          db,
          requireUser(request).id,
          id,
        );
        return unmirrorAddressBookResponseSchema.parse({
          addressBook: toWireAddressBook(addressBook),
          discarded,
        });
      } catch (err) {
        return replyForAddressBookError(err, reply);
      }
    },
  );

  app.post("/address-books/:id/mirror", { preHandler: app.requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const addressBook = await mirrorAddressBook(db, requireUser(request).id, id);
      return mirrorAddressBookResponseSchema.parse({
        addressBook: toWireAddressBook(addressBook),
      });
    } catch (err) {
      return replyForAddressBookError(err, reply);
    }
  });
}

function replyForAddressBookError(err: unknown, reply: FastifyReply) {
  if (err instanceof AddressBookNotFoundError) {
    return reply.code(404).send({ error: "not_found" });
  }
  if (err instanceof AddressBookNotMirrorableError) {
    return reply.code(400).send({ error: "not_mirrorable" });
  }
  throw err;
}

/** Same shape as every other authenticated route's own inline helper (`mail-accounts.ts`'s sibling one). */
function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
