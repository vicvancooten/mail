import type { ContactEmail, CustomField } from "@mail/shared";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../db/client.js";
import { contacts } from "../db/schema.js";
import type { Repair } from "../repairs/runner.js";

const validEmail = z.email();

/**
 * Splits a Contact's Custom Fields into the ones that stay and the ones a
 * valid email address promotes into `emails` — `splitTypedContactFields`'s
 * own email branch (#283, `@mail/shared#contacts.ts`), run in reverse
 * against data that branch predates. The field's own `label` becomes the
 * promoted email's `type` (a blank label defaults to `"home"`, the same
 * default `splitTypedContactFields` applies), and its `id` carries over
 * unchanged — the same entry, no longer demoted. `primary` is always
 * `false`: a Custom Field carries no such flag to recover, and
 * `resolveContactPrimaryEmail` already falls back to the first email when
 * none is flagged.
 */
function promoteDemotedEmails(
  customFields: readonly CustomField[],
): { emails: ContactEmail[]; customFields: CustomField[] } | null {
  const kept: CustomField[] = [];
  const promoted: ContactEmail[] = [];
  for (const field of customFields) {
    if (validEmail.safeParse(field.value).success) {
      promoted.push({
        id: field.id,
        type: field.label.trim().length > 0 ? field.label : "home",
        value: field.value,
        primary: false,
      });
    } else {
      kept.push(field);
    }
  }
  return promoted.length > 0 ? { emails: promoted, customFields: kept } : null;
}

/**
 * "Repair demoted addresses once" (#284): the one-off repair for #283's own
 * bug — a Custom Field holding a valid email address dropped that address
 * out of the Contact's mail history. Promotes every such Custom Field back
 * into `emails`, keeping its label as the address label, and drops it from
 * `customFields`. A Custom Field whose value isn't a valid email is left
 * exactly as it is.
 *
 * Scoped to every Contact regardless of Origin or owning User — the bug
 * predates #283 account-wide, not per User. The `jsonb_array_length` filter
 * is this one-time full-table sweep's only concession to cost: it skips a
 * Contact with no Custom Fields at all without ever inspecting its `emails`.
 * The repaired row's ordinary `updated_at`/`sync_rev` write (the
 * `contacts_bump_sync_rev` trigger, migration 0049) is what carries it to
 * Clients as a plain delta on their next sync — nothing here talks to
 * `sync/tombstones.ts` or any upstream write-back outbox, since nothing
 * about a Contact's identity or its Origin changes.
 */
export const repairDemotedAddresses: Repair = {
  name: "repair-demoted-addresses",
  run: async (tx: Tx) => {
    const rows = await tx
      .select({ id: contacts.id, emails: contacts.emails, customFields: contacts.customFields })
      .from(contacts)
      .where(sql`jsonb_array_length(${contacts.customFields}) > 0`);

    for (const row of rows) {
      const result = promoteDemotedEmails(row.customFields);
      if (!result) continue;

      await tx
        .update(contacts)
        .set({
          emails: [...row.emails, ...result.emails],
          customFields: result.customFields,
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, row.id));
    }
  },
};
