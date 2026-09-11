import { z } from "zod";

/**
 * `Rollback` (#229, ADR-0025's "Rollback becomes a User-scoped collection...
 * one row per rejected outbox entry"). Built here, in the Calendar/Event
 * ticket, because Contacts consumes it too (#229's ticket body) rather than
 * inventing a second rollback path — but nothing produces a row yet: the
 * outbox and upstream-wins write-back this exists for is #237
 * ("Write-back to Google, with the outbox and upstream-wins Rollback"). This
 * collection is therefore always empty on this line, the same "wire shape
 * before any producer" posture `eventSchema` takes.
 *
 * User-scoped (ADR-0025), whole-replicated like `labelSchema`/`noteSchema` —
 * a User has at most a handful of open Rollbacks at once, tombstoned after
 * seven days server-side (ADR-0025) once #237 lands the sweep.
 */
export const rollbackSchema = z.object({
  id: z.string(),
  userId: z.string(),
  /** The collection the reverted write belonged to, e.g. `"Event"` — never a route or table name. */
  collection: z.string(),
  /** The row the write targeted, so the Client can find what to show the toast against. */
  entityId: z.string(),
  /** A short, User-facing reason (e.g. the upstream's rejection), or `null` when none was given. */
  reason: z.string().nullable(),
  occurredAt: z.iso.datetime(),
});
export type Rollback = z.infer<typeof rollbackSchema>;
