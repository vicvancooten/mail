import type { Contact, Correspondent } from "@mail/shared";
import { normalizeCorrespondentAddress } from "@mail/shared";

/**
 * One row of the "People you've mailed" tab (#218, `docs/contacts-spec.md`
 * §Correspondents, compose and the Gatekeeper): a Correspondent merged
 * across every Mail Account in Account Scope by normalised address, with no
 * Contact of its own yet. Unlike `RecipientCandidate`
 * (`compose/recipients.ts`) there is no never-mailed tier here — every row
 * in this tab has a score by construction — and no `contactId`, since the
 * whole point of the row is that one doesn't exist.
 */
export interface MailedPersonRow {
  /** The row's own stable key: the normalised address, since two Correspondents at different Mail Accounts collapse into the one row (`mergeCorrespondentsAcrossAccounts`'s own doc comment). */
  address: string;
  name: string | null;
  score: number;
}

/**
 * Merges Correspondents from every Mail Account in Account Scope into one
 * ranked list by normalised address (this ticket's own acceptance line) —
 * `mergeContactsIntoCorrespondents`'s (`compose/recipients.ts`) own
 * normalise-and-key shape, just without a Contact side to merge in. Two
 * Mail Accounts holding the same address as two distinct Correspondents
 * (`correspondents.ts#correspondentId`'s own per-Mail-Account scoping)
 * collapse into whichever carries the higher score — "ranked by Correspondent
 * score" is meaningless per-row otherwise — and that row's `address`/`name`
 * are the ones the higher-scoring Correspondent itself carries, so casing
 * and a longer known name both survive the merge the same way
 * `upsertCorrespondent`'s own "longest name wins" already behaves within one
 * Mail Account.
 */
export function mergeCorrespondentsAcrossAccounts(
  correspondents: readonly Correspondent[],
): MailedPersonRow[] {
  const byAddress = new Map<string, MailedPersonRow>();
  for (const correspondent of correspondents) {
    const normalized = normalizeCorrespondentAddress(correspondent.address);
    const current = byAddress.get(normalized);
    if (!current || correspondent.score > current.score) {
      byAddress.set(normalized, {
        address: correspondent.address,
        name: correspondent.name,
        score: correspondent.score,
      });
    }
  }
  return [...byAddress.values()].sort((left, right) => right.score - left.score);
}

/**
 * Drops every row already on a Contact (this ticket's own acceptance line:
 * "minus every address already on a Contact", computed locally against the
 * whole-replicated Contacts collection, not scoped by Address Book or
 * Account Scope — `store/contacts.ts#useContacts`'s own doc comment on why a
 * Contact is never Mail-Account-scoped). Reactive by construction: the
 * caller feeds this the live `useContacts()` snapshot, so the row for a
 * newly-saved Correspondent disappears the moment the optimistic
 * `createContact` write lands and `useContacts()` re-renders — no extra
 * plumbing, the same posture `useLiveQuery` already gives every other read.
 */
export function excludeContactAddresses(
  rows: readonly MailedPersonRow[],
  contacts: readonly Contact[],
): MailedPersonRow[] {
  const contactAddresses = new Set<string>();
  for (const contact of contacts) {
    for (const email of contact.emails) {
      contactAddresses.add(normalizeCorrespondentAddress(email.value));
    }
  }
  return rows.filter((row) => !contactAddresses.has(normalizeCorrespondentAddress(row.address)));
}

/** The tab's whole pipeline in one call: merge across Mail Accounts, then exclude anyone already a Contact. */
export function peopleYouveMailed(
  correspondents: readonly Correspondent[],
  contacts: readonly Contact[],
): MailedPersonRow[] {
  return excludeContactAddresses(mergeCorrespondentsAcrossAccounts(correspondents), contacts);
}
