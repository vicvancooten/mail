import type { CollectionDelta } from "@mail/shared";
import {
  type ApplyDeltaOptions,
  applyCompositionDelta,
  applyCorrespondentDelta,
  applyGmailLabelDelta,
  applyLabelDelta,
  applyMailAccountDelta,
  applyPreferenceDelta,
  applyThreadDelta,
  compositionTokenKey,
  correspondentTokenKey,
  gmailLabelTokenKey,
  labelTokenKey,
  MAIL_ACCOUNT_TOKEN_KEY,
  PREFERENCE_TOKEN_KEY,
  threadTokenKey,
} from "../store/server-writes.js";

/**
 * The one collection registry (#185). Every collection this Client holds —
 * wire name, Local Cache table, state-token key, and the function that
 * applies a delta to the table — is declared exactly once, here, split into
 * the two scopes the wire protocol itself has (`packages/shared/src/sync.ts`:
 * `userSyncRequestSchema`/`userSyncResponseSchema` vs.
 * `mailAccountSyncRequestSchema`/`mailAccountSyncResponseSchema`). `sync-round.ts`
 * reads these two arrays and nothing else to build a request and apply a
 * response, so a new collection is one entry here rather than a matching edit
 * in the request builder, the apply pass, and the orphan-cleanup list.
 *
 * Payload types differ per collection (`Thread`, `Label`, a `Preference`
 * row, ...), so the arrays below are necessarily non-generic — `apply`'s
 * declared type is `CollectionDelta<unknown>`, the one shape every
 * collection's delta shares. `asApplyUserDelta`/`asApplyMailAccountDelta`
 * are the single, deliberate place that erases each entry's real Payload
 * type down to that common shape; every other line here stays fully typed
 * against the concrete `apply*Delta` function it wraps.
 */

/** The Local Cache (Dexie) table one collection's rows live in. */
export type CollectionTable =
  | "mailAccounts"
  | "preferences"
  | "threads"
  | "labels"
  | "gmailLabels"
  | "compositions"
  | "correspondents";

type ApplyUserCollectionDelta = (
  delta: CollectionDelta<unknown>,
  options: ApplyDeltaOptions,
) => Promise<void>;

type ApplyMailAccountCollectionDelta = (
  mailAccountId: string,
  delta: CollectionDelta<unknown>,
  options: ApplyDeltaOptions,
) => Promise<void>;

function asApplyUserDelta<Payload>(
  apply: (delta: CollectionDelta<Payload>, options: ApplyDeltaOptions) => Promise<void>,
): ApplyUserCollectionDelta {
  return apply as ApplyUserCollectionDelta;
}

function asApplyMailAccountDelta<Payload>(
  apply: (
    mailAccountId: string,
    delta: CollectionDelta<Payload>,
    options: ApplyDeltaOptions,
  ) => Promise<void>,
): ApplyMailAccountCollectionDelta {
  return apply as ApplyMailAccountCollectionDelta;
}

/** A User-scoped collection: `userSyncRequestSchema`/`userSyncResponseSchema`'s `MailAccount`/`Preference` keys. */
export interface UserCollectionEntry {
  readonly wireKey: "MailAccount" | "Preference";
  readonly table: CollectionTable;
  readonly tokenKey: string;
  readonly apply: ApplyUserCollectionDelta;
}

/** A per-Mail-Account collection: `mailAccountSyncRequestSchema`/`mailAccountSyncResponseSchema`'s five keys. */
export interface MailAccountCollectionEntry {
  readonly wireKey: "Thread" | "Label" | "GmailLabel" | "Composition" | "Correspondent";
  readonly table: CollectionTable;
  readonly tokenKey: (mailAccountId: string) => string;
  readonly apply: ApplyMailAccountCollectionDelta;
}

export const USER_COLLECTIONS: readonly UserCollectionEntry[] = [
  {
    wireKey: "MailAccount",
    table: "mailAccounts",
    tokenKey: MAIL_ACCOUNT_TOKEN_KEY,
    apply: asApplyUserDelta(applyMailAccountDelta),
  },
  {
    wireKey: "Preference",
    table: "preferences",
    tokenKey: PREFERENCE_TOKEN_KEY,
    apply: asApplyUserDelta(applyPreferenceDelta),
  },
];

export const MAIL_ACCOUNT_COLLECTIONS: readonly MailAccountCollectionEntry[] = [
  {
    wireKey: "Thread",
    table: "threads",
    tokenKey: threadTokenKey,
    apply: asApplyMailAccountDelta(applyThreadDelta),
  },
  {
    wireKey: "Label",
    table: "labels",
    tokenKey: labelTokenKey,
    apply: asApplyMailAccountDelta(applyLabelDelta),
  },
  {
    wireKey: "GmailLabel",
    table: "gmailLabels",
    tokenKey: gmailLabelTokenKey,
    apply: asApplyMailAccountDelta(applyGmailLabelDelta),
  },
  {
    wireKey: "Composition",
    table: "compositions",
    tokenKey: compositionTokenKey,
    apply: asApplyMailAccountDelta(applyCompositionDelta),
  },
  {
    wireKey: "Correspondent",
    table: "correspondents",
    tokenKey: correspondentTokenKey,
    apply: asApplyMailAccountDelta(applyCorrespondentDelta),
  },
];
