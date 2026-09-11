import { z } from "zod";
import { addressBookSchema } from "./address-books.js";
import { calendarSchema } from "./calendars.js";
import {
  composeSaveOutcomeSchema,
  composeSaveSchema,
  compositionSchema,
  undoSendDelaySchema,
} from "./compose.js";
import { connectedAccountSchema } from "./connected-accounts.js";
import { contactLinkSchema } from "./contact-links.js";
import {
  contactBannerSchema,
  contactRollbackSchema,
  contactSchema,
  contactsSortOrderSchema,
  contactWritableFieldsSchema,
} from "./contacts.js";
import { eventSchema } from "./events.js";
import { gatekeeperSenderSchema } from "./gatekeeper.js";
import { mailAccountSchema, remoteImagesSettingSchema } from "./mail-accounts.js";
import { noteSaveOutcomeSchema, noteSaveSchema, noteSchema } from "./notes.js";
import { snoozeUntilSchema } from "./push.js";
import { reminderDefaultSchema } from "./reminders.js";
import { rollbackSchema } from "./rollback.js";
import { seriesSaveOutcomeSchema, seriesSaveSchema } from "./series.js";

/**
 * The one delta endpoint (ADR-0011): `POST /sync` carries a map of
 * `{collection → stateToken}`, scoped per Mail Account plus a set of
 * User-scoped collections, and answers with per-collection
 * `{created, updated, destroyed, newState, hasMore}`. `MailAccount` is
 * User-scoped, and so are `Preference` and `Label` (#186); `Thread` and
 * `Composition` are per Mail Account —
 * the envelope below is additive-only, so `Preference`/etc. land in their
 * own tickets as new optional fields on the same request/response shapes,
 * never a reshape of them.
 *
 * A `stateToken` is opaque to the Client — it round-trips whatever this
 * package hands back and is never constructed or inspected client-side.
 */

/** One `From`/`To` participant, as it appears on a Thread's `participants`. */
export const threadParticipantSchema = z.object({
  name: z.string().nullable(),
  address: z.string(),
});
export type ThreadParticipant = z.infer<typeof threadParticipantSchema>;

/**
 * The wire projection of a Thread (CONTEXT.md): the list-row summary, never
 * a Message body. Denormalized fields (`snippet`, `unreadCount`, ...) mirror
 * `sync/thread-rollup.ts`'s columns — this schema is that rollup's contract
 * with every Client.
 */
export const threadSchema = z.object({
  id: z.string(),
  mailAccountId: z.string(),
  subject: z.string(),
  participants: z.array(threadParticipantSchema),
  /** Null while the newest message's body is still behind the Index Watermark (#36). */
  snippet: z.string().nullable(),
  lastMessageId: z.string().nullable(),
  firstMessageAt: z.iso.datetime().nullable(),
  lastMessageAt: z.iso.datetime().nullable(),
  messageCount: z.int(),
  unreadCount: z.int(),
  starred: z.boolean(),
  hasAttachments: z.boolean(),
  /**
   * Whether this Thread currently has a Message sitting in the Inbox
   * (#42). Not a general Folder projection — the Client still holds exactly
   * one list per Mail Account (`db.ts`) — just the one signal triage needs:
   * archiving/trashing flips it to `false` server-side (`sync/mutations.ts`)
   * so the Thread drops out of that list for good, on every Client, once
   * the intent lands, and not only for the duration of the Client's own
   * pending overlay.
   */
  inInbox: z.boolean(),
  /**
   * The sidebar folder destination this Thread currently sits in (#74),
   * beyond the plain "in the Inbox or not" `inInbox` above: `"archive"` and
   * `"trash"` are what tell the two apart, App-owned exactly like `inInbox`
   * — set synchronously by `archive`/`trash` (and the Screener decisions and
   * Bulk Triage's `done` action that share their effect), the real IMAP
   * `MOVE` following asynchronously after. One-directional today, the same
   * as `inInbox`: nothing sets a Thread back to `"inbox"` from `"archive"`
   * (there is no unarchive yet) except Bulk Triage's own Undo.
   *
   * `"junk"` (#102) is Spam's own destination — the Screener's `spamSender`
   * decision and a Spam sender's future arrivals set it instead of
   * `"trash"`. There is no Junk sidebar entry (`search/scope.ts`'s `in:junk`
   * is the only way there today), so this value simply drops a Thread out of
   * every folder-scoped view (Archive, Trash) rather than gaining one of its
   * own — exactly the "out of sight, provider's filter takes it from here"
   * Spam means.
   */
  folderRole: z.enum(["inbox", "archive", "trash", "junk"]),
  /**
   * Whether this Thread has at least one Message the Sync Backend ingested
   * from the account's real `\Sent` folder (#74) — unlike `folderRole`
   * above, a real signal recomputed by `sync/thread-rollup.ts` on every
   * pass, never an Optimistic Action's own field, because there is no
   * "queue this to become Sent" intent: a Thread lands here by actually
   * containing a sent Message. Independent of `folderRole`/`inInbox` — a
   * sent reply can still be sitting in the Inbox, or since archived — and
   * belongs in the Sent sidebar view either way.
   */
  hasSentMessage: z.boolean(),
  /**
   * Whether this Thread is Pinned (#43): an App Feature, deliberately
   * distinct from `starred` (CONTEXT.md — a Star says "this matters", a Pin
   * says "keep this in front of me"). The Client sorts Pinned Threads to the
   * top of every view mode regardless of their date.
   */
  pinned: z.boolean(),
  /**
   * The Labels currently applied to this Thread, as `Label.id`s (#43,
   * User-scoped since #186 — an id here belongs to the owning User's one
   * Label set, not to this Thread's Mail Account). An
   * App Feature, denormalized here the same way `starred` is — the
   * `Label` collection below carries the id→name mapping, this is the
   * per-Thread membership, kept on the Thread row (rather than requiring a
   * join client-side) because every view already renders off one Thread
   * projection.
   */
  labelIds: z.array(z.string()),
  /**
   * The Gmail Labels currently on this Thread, as `GmailLabel.id`s (#126,
   * ADR-0020) — `labelIds`'s sibling, never merged into it: a Gmail Label is
   * never a Wicket Label (CONTEXT.md). Always empty on a non-Gmail Mail
   * Account. Denormalized the same way `labelIds` is, from the union of every
   * Message in the Thread's `X-GM-LABELS` (a Gmail conversation's messages
   * are not always labelled identically), system pseudo-labels
   * (`\Inbox`/`\Sent`/`\Starred`/Important/Categories/Chats) excluded — those
   * are never browsable Gmail Labels, see `GmailLabel` below.
   */
  gmailLabelIds: z.array(z.string()),
  /**
   * The Screening Hold (#55, CONTEXT.md): the normalized `From` address of
   * the Unscreened Sender whose mail is holding this Thread in the Screener,
   * or `null` when the Thread is not held — which is every Thread on a Mail
   * Account with Gatekeeper switched off.
   *
   * One nullable address rather than a `held` boolean beside a sender field,
   * because a hold only ever exists for a message that *started* a Thread
   * (poc-spec.md) — so there is exactly one sender to name, and the two can
   * never disagree. The Screener groups its rows by this value; the Inbox
   * filters on it; `inInbox` deliberately stays `true` throughout, because a
   * held Thread is Inbox mail the User has not been shown yet, not mail that
   * has been archived.
   *
   * An App Feature with no IMAP-side trace (ADR-0008: "The Screening Hold
   * itself stays an App Feature ... held mail is filtered out of the Inbox
   * view, never moved"), which is also what makes Approve's "release with
   * original received dates" free: nothing ever moved, so nothing has a date
   * to restore.
   */
  heldSender: z.string().nullable(),
  /**
   * The Alias (CONTEXT.md) this held Thread's opening message resolved to at
   * ingest — `Delivered-To`/`X-Original-To`/`To`+`Cc`, whichever first named
   * an address at the Mail Account's own domain (#103,
   * `gatekeeper/alias.ts#resolveRecipientAlias` in the Sync Backend) — or
   * `null` when nothing on the message did. `null` whenever `heldSender` is,
   * for the same reason: a hold only ever exists for a message that started
   * a Thread, so there is exactly one recipient Alias to name.
   *
   * What the Screener's Block split menu reads to offer *Block everything
   * sent to `<alias>`* (#103) — a third, recipient-scoped Verdict scope
   * alongside `heldSender`'s address/domain ones, beating even an Approved
   * Sender.
   */
  heldRecipientAlias: z.string().nullable(),
  /**
   * Snooze (#76, CONTEXT.md: "hiding a thread until a chosen time, after
   * which it returns as new"): the instant this Thread wakes, or `null` when
   * it isn't snoozed. An App Feature (ADR-0006) with zero IMAP-side trace —
   * `inInbox` flips to `false` the same instant this is set (the same
   * synchronous-ack shape `archive`/`trash` already use), and back to `true`
   * once the Sync Backend's wake sweep clears this field, with nothing ever
   * written to the mailbox either way. One-directional the same way
   * `archive`/`trash` are: there is no "un-snooze early" intent yet, so the
   * only way this clears is the wake sweep itself.
   */
  snoozeUntil: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type Thread = z.infer<typeof threadSchema>;

/**
 * A Label (#43, CONTEXT.md): a User-defined tag, App Feature, no colors or
 * nesting at PoC scope. `id` is deterministic (`labelId` in
 * `packages/shared/src/labels.ts`) rather than server-minted, so applying a
 * brand-new Label is a single Optimistic Action with no id round trip first.
 *
 * **User-scoped** since #186 (ADR-0023): one set of Labels spans every Mail
 * Account a User owns, so this carries `userId` and the collection rides the
 * `user` half of the envelope rather than a per-Mail-Account bucket. A Thread
 * of any of that User's accounts can therefore reference any of these ids in
 * its `labelIds`. `GmailLabel` below did *not* move — it is genuinely one
 * Gmail account's own read-only tag set, never a Wicket Label.
 */
export const labelSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  updatedAt: z.iso.datetime(),
});
export type Label = z.infer<typeof labelSchema>;

/**
 * A Gmail Label (#126, ADR-0020, CONTEXT.md): Gmail's own tag on a message,
 * which IMAP shows as a folder — browsable, never editable from Wicket, and
 * never a Wicket `Label` above. Synced read-only from the User's actual
 * Gmail account (`sync/gmail-labels.ts`'s `persistGmailLabels`, fed by the
 * same folder listing `sync/folders.ts#discoverFolders` already performs),
 * never created by a mutation intent — there is no `applyGmailLabel`. `id` is
 * deterministic (`gmailLabelId` in `packages/shared/src/gmail-labels.ts`,
 * `(mailAccountId, path)`), so a rename (a new IMAP path) is a destroy of the
 * old id plus a create of the new one, not an update in place — the same
 * "tombstone or rename observed through the collection" shape every
 * path-keyed synced row gets. `name` is the display leaf ("Kids"); `path` is
 * Gmail's own full hierarchy ("Family/Kids") — `folders.ts`'s own
 * `name`/`path` split, reused rather than reinvented.
 */
export const gmailLabelSchema = z.object({
  id: z.string(),
  mailAccountId: z.string(),
  name: z.string(),
  path: z.string(),
  updatedAt: z.iso.datetime(),
});
export type GmailLabel = z.infer<typeof gmailLabelSchema>;

/**
 * One collection's delta since the state token the Client sent.
 * `reset: true` (ADR-0011) replaces the merge-in-place contract: the Client
 * discards whatever it had for this collection and treats `created` as the
 * whole current page instead of an addition to it. It is set on every page
 * of a reset's replay, not just the first, so a Client keeps replacing
 * (rather than merging) until `hasMore` finally goes false. Absent (never
 * `false`) the rest of the time.
 */
function collectionDeltaSchema<Payload extends z.ZodTypeAny>(payload: Payload) {
  return z.object({
    created: z.array(payload),
    updated: z.array(payload),
    /** Entity ids no longer in the collection — `sync/tombstones.ts`'s only readers. */
    destroyed: z.array(z.string()),
    newState: z.string(),
    hasMore: z.boolean(),
    reset: z.literal(true).optional(),
  });
}
export type CollectionDelta<Payload> = {
  created: Payload[];
  updated: Payload[];
  destroyed: string[];
  newState: string;
  hasMore: boolean;
  reset?: true;
};

export const mailAccountDeltaSchema = collectionDeltaSchema(mailAccountSchema);
export type MailAccountDelta = z.infer<typeof mailAccountDeltaSchema>;

export const threadDeltaSchema = collectionDeltaSchema(threadSchema);
export type ThreadDelta = z.infer<typeof threadDeltaSchema>;

export const labelDeltaSchema = collectionDeltaSchema(labelSchema);
export type LabelDelta = z.infer<typeof labelDeltaSchema>;

export const gmailLabelDeltaSchema = collectionDeltaSchema(gmailLabelSchema);
export type GmailLabelDelta = z.infer<typeof gmailLabelDeltaSchema>;

/** `Note` (#192, ADR-0023): whole-replicated, User-scoped — see `notes.ts#noteSchema`'s own doc comment. */
export const noteDeltaSchema = collectionDeltaSchema(noteSchema);
export type NoteDelta = z.infer<typeof noteDeltaSchema>;

/** `ContactRollback` (#216): append-only, User-scoped — see `contacts.ts#contactRollbackSchema`'s own doc comment. `updated`/`destroyed` are always empty; a row is written once and never revisited. */
export const contactRollbackDeltaSchema = collectionDeltaSchema(contactRollbackSchema);
export type ContactRollbackDelta = z.infer<typeof contactRollbackDeltaSchema>;

/** `Calendar` (#229): whole-replicated, User-scoped — see `calendars.ts#calendarSchema`'s own doc comment. */
export const calendarDeltaSchema = collectionDeltaSchema(calendarSchema);
export type CalendarDelta = z.infer<typeof calendarDeltaSchema>;

/**
 * `Event` (#229): the one windowed App collection (ADR-0023, ADR-0025) —
 * `windowStart`/`windowEnd` ride alongside the ordinary delta fields so the
 * Client can draw the Event Window honestly, the same way `MailAccount`'s
 * `indexWatermark` does for mail's own bounded sweep. Present whenever the
 * delta itself is (i.e. whenever `collectionDeltaSchema` would not have
 * collapsed the response to "nothing changed") — see `events.ts` for why
 * both edges are simply recomputed from "now" on this ticket's line.
 */
export const eventDeltaSchema = collectionDeltaSchema(eventSchema).extend({
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
});
export type EventDelta = z.infer<typeof eventDeltaSchema>;

/** `Rollback` (#229, ADR-0025): whole-replicated, User-scoped — see `rollback.ts#rollbackSchema`'s own doc comment. */
export const rollbackDeltaSchema = collectionDeltaSchema(rollbackSchema);
export type RollbackDelta = z.infer<typeof rollbackDeltaSchema>;

/** Where Auto-advance (CONTEXT.md) moves after archive/trash: to the next-older or next-newer Thread in the list. */
export const autoAdvanceDirectionSchema = z.enum(["older", "newer"]);
export type AutoAdvanceDirection = z.infer<typeof autoAdvanceDirectionSchema>;
export const DEFAULT_AUTO_ADVANCE_DIRECTION: AutoAdvanceDirection = "older";
export const DEFAULT_AUTO_ADVANCE_ENABLED = true;

/**
 * `Preference` (#54, poc-spec.md §Preferences, ADR-0011): the User-scoped
 * synced preference collection — Auto-advance on/off and direction, and the
 * Undo Send delay, "the same everywhere the User signs in" (CONTEXT.md's
 * Device Preference entry, by contrast). Exactly one row per User, `id` is
 * the owning User's id rather than a minted one — there is never a second
 * row to distinguish it from — which is what lets this ride the ordinary
 * `CollectionDelta` shape every other collection uses
 * (`sync/collection-sync.ts`) with no windowing or pagination of its own.
 *
 * Theme lived here until #72 (ADR-0011 amended): a laptop and a phone in the
 * same hour want different Appearances, so it moved to a Device Preference
 * (`apps/client/src/theme/device-theme.ts`) — `localStorage`, never synced.
 */
/**
 * The IANA zone the Sync Backend uses whenever it must turn a date or a
 * floating time into a real instant on this User's behalf (#189) — Calendar
 * reminders and Local Calendars are the first callers (ADR-0028), not yet
 * landed. `""` is "not seeded yet", never a zone a picker can select: seeding
 * is the signing-in device's job (`client/src/settings/use-seed-home-time-
 * zone.ts`), not a server-side default, because the one thing this preference
 * must never be is "inferred from the server's clock".
 */
export const HOME_TIME_ZONE_UNSET = "";

export const preferenceSchema = z.object({
  id: z.string(),
  autoAdvanceEnabled: z.boolean(),
  autoAdvanceDirection: autoAdvanceDirectionSchema,
  undoSendDelaySeconds: undoSendDelaySchema,
  homeTimeZone: z.string(),
  /** The Contacts App's own sort order (#211): first name or last name first — see `contacts.ts#contactsSortOrderSchema`'s own doc comment. */
  contactsSortOrder: contactsSortOrderSchema,
  /**
   * "Answers arriving for Events the User organises" (#243): its own
   * per-User toggle beside the per-Calendar Reminders one on the
   * Notifications page, User-scoped like every other Preference field —
   * default `true`, the same posture `remindersEnabled` gives every Origin.
   */
  answerNotificationsEnabled: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type Preference = z.infer<typeof preferenceSchema>;

/** `Preference`'s own default for `answerNotificationsEnabled` — `DEFAULT_AUTO_ADVANCE_ENABLED`'s sibling. */
export const DEFAULT_ANSWER_NOTIFICATIONS_ENABLED = true;

export const preferenceDeltaSchema = collectionDeltaSchema(preferenceSchema);
export type PreferenceDelta = z.infer<typeof preferenceDeltaSchema>;

/**
 * The User-scoped Optimistic Actions `Preference` accepts (ADR-0010): each is
 * an absolute set on one field, mirroring `setPinned`'s shape rather than a
 * single "patch" intent, so two edits queued offline against different
 * fields never clobber each other and the debug view reads as plainly as
 * every other intent. None ever touches IMAP — a Preference is App Feature
 * state through and through.
 */
export const userMutationIntentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("setAutoAdvance"),
    enabled: z.boolean(),
    direction: autoAdvanceDirectionSchema,
  }),
  z.object({ type: z.literal("setUndoSendDelay"), undoSendDelaySeconds: undoSendDelaySchema }),
  /**
   * Home Time Zone (#189): a raw IANA zone name, e.g. `"Europe/Amsterdam"`.
   * The Client only ever sends a zone `Intl.supportedValuesOf("timeZone")`
   * itself offered — the picker and the seeding effect are the validation,
   * the same posture `setUndoSendDelay` takes on its own enum of seconds.
   */
  z.object({ type: z.literal("setHomeTimeZone"), homeTimeZone: z.string().min(1) }),
  /** Contacts sort order (#211): `contactsSortOrderSchema`'s own enum, the same absolute-set shape as `setHomeTimeZone`/`setUndoSendDelay` above. */
  z.object({ type: z.literal("setContactsSortOrder"), contactsSortOrder: contactsSortOrderSchema }),
  /**
   * The Default Address Book (#211, `address-books.ts#addressBookSchema`'s
   * own doc comment: "the Local Address Book is the default until a later
   * ticket lets the User change it" — this is that ticket): flips
   * `AddressBook.isDefault` so it lands on exactly one row for this User,
   * across every Origin — not a `Preference` field of its own, since
   * `isDefault` already exists on the wire and duplicating "which one is
   * default" into two collections could let them disagree. An absolute
   * set, same posture as the `Preference` variants above: a second pick
   * before the first ever reaches the Sync Backend simply replaces it
   * (`user-mutation-queue.ts#coalesceKey`).
   */
  z.object({ type: z.literal("setDefaultAddressBook"), addressBookId: z.string() }),
  /**
   * "Answer received" notification on/off (#243): an absolute set, the same
   * shape as `setNotificationsEnabled` (`mutations.ts`) but User-scoped
   * rather than per-Mail-Account, since an Answer names no one Mail Account
   * in particular — it can arrive at whichever address the organiser sent
   * the `REQUEST` through.
   */
  z.object({ type: z.literal("setAnswerNotificationsEnabled"), enabled: z.boolean() }),
  /**
   * A Note's structural actions (#192, ADR-0023; `pinNote`/`unpinNote` joined
   * in #193): ordinary Optimistic Action intents on the User-scoped queue,
   * real inverses per ADR-0019, exactly like a Thread's
   * `applyLabel`/`removeLabel` — the difference is only which queue they
   * ride, since a Note has no Mail Account to scope to. Body edits are the
   * different half (`notes.ts#noteSaveSchema`'s own doc comment); none of
   * these six ever touch a Note's `document`.
   *
   * `createNote`/`deleteNote` are a genuine inverse pair (ADR-0019, the same
   * shape `discardComposition`/`undiscardComposition` already have): `noteId`
   * is the Client-minted ULID (`notes.ts#noteSchema`'s own doc comment),
   * already known before this intent is ever enqueued. `deleteNote` here is
   * the **permanent** delete that undoes a still-queued or already-applied
   * `createNote` — not the soft-delete/Recently Deleted feature (#194)
   * below, which arrives with its own intent pair.
   *
   * `labelNote`/`unlabelNote` carry the Label's `name`, the same
   * `applyLabel`/`removeLabel` shape — the id is deterministic
   * (`labels.ts#labelId`) from `(userId, name)`, so both sides derive it
   * independently rather than one minting it and handing it to the other.
   *
   * `pinNote`/`unpinNote` (#193) are the grid's Pinned/Others split, a
   * genuine inverse pair the same way `createNote`/`deleteNote` are —
   * deliberately not a Thread-style absolute `setPinned {pinned: boolean}`,
   * since that shape has no natural inverse for
   * `user-mutation-queue.ts#coalesceKey`'s cancel-pair trick to use.
   *
   * `trashNote`/`restoreNote` (#194) are Delete and Recently Deleted's own
   * Restore: a genuine inverse pair too, the same shape as `pinNote`/
   * `unpinNote` above, except the field they flip is `deletedAt`
   * (`notes.ts#noteSchema`'s own doc comment) rather than a physical row —
   * `deleteNote` above stays the permanent delete it always was, this pair
   * is the undoable, then-recoverable-for-30-days one the User's own
   * "Delete" control actually fires.
   */
  z.object({ type: z.literal("createNote"), noteId: z.string() }),
  z.object({ type: z.literal("deleteNote"), noteId: z.string() }),
  z.object({ type: z.literal("labelNote"), noteId: z.string(), name: z.string() }),
  z.object({ type: z.literal("unlabelNote"), noteId: z.string(), name: z.string() }),
  z.object({ type: z.literal("pinNote"), noteId: z.string() }),
  z.object({ type: z.literal("unpinNote"), noteId: z.string() }),
  z.object({ type: z.literal("trashNote"), noteId: z.string() }),
  z.object({ type: z.literal("restoreNote"), noteId: z.string() }),
  /**
   * A Local Contact's structural actions (#210, ADR-0026): ordinary
   * User-scoped Optimistic Action intents, real inverses per ADR-0019,
   * `Note`'s own six above extended by one — `updateContact` — for the
   * field-family edits a Note has no analogue of.
   *
   * `createContact`/`deleteContact` are a genuine inverse pair, exactly
   * `createNote`/`deleteNote`'s shape: `contactId` is the Client-minted ULID
   * (`contacts.ts#contactSchema`'s own doc comment), already known before
   * this intent is ever enqueued, and `deleteContact` is the **permanent**
   * delete that undoes a still-queued or already-applied `createContact` —
   * never the User's own "Delete" control, which fires `trashContact` below.
   *
   * `trashContact`/`restoreContact` (#224) are Delete and Recently Deleted's
   * own Restore, arriving after `Note`'s own `trashNote`/`restoreNote` (#194)
   * exactly the way this doc comment once predicted: a genuine inverse pair,
   * the same shape, except the field they flip is `deletedAt`
   * (`contacts.ts#contactSchema`'s own doc comment) rather than a physical
   * row. Unlike a Note, a synced Contact's mirror identity
   * (`googleResourceName`/`microsoftId` and siblings) is discarded the
   * instant `trashContact` lands (ADR-0029: "removal discards the mirror ...
   * a confirmed act") and the Sync Backend's own write-back outbox removes
   * Google's/Graph's copy at once; `restoreContact` re-queues a **fresh**
   * upstream create rather than reactivating the old one, which is what
   * keeps the same Wicket id (and so its Labels and links) across the round
   * trip. On a linked card (ADR-0026) the Sync Backend cascades either
   * intent to every record the named Contact is linked with, so "Delete on a
   * linked card deletes every linked record; one Undo restores all of them"
   * holds with the Client only ever naming the one record its own Delete
   * control was clicked against.
   *
   * `addressBookId` (#225) names the target explicitly — #210 shipped this
   * carrying none at all, always resolving to the caller's own Local
   * Address Book (`sync/mutations.ts`'s prior doc comment on that case);
   * Import and Copy/Move both need an ordinary create that can land in *any*
   * Address Book the User owns, mirrored ones included, so `createContact`
   * is now that one path, capability-checked against whichever table
   * `addressBookId` actually names (`sync/mutations.ts`'s own doc comment on
   * why this still isn't a mirrored-Origin write-back for every Origin).
   *
   * `updateContact` carries the Contact's whole `ContactWritableFields` —
   * every family in one intent, never a per-family patch
   * (`contacts.ts#contactWritableFieldsSchema`'s own doc comment) — and is
   * its own real inverse: re-applying the fields as they stood before the
   * edit, through this same intent type, is a real action on the wire
   * (ADR-0019), not a queue cancellation, even though it is not a distinct
   * paired type the way a boolean toggle's inverse is. Whoever calls it
   * (the edit form) is the one holding the "before" state to replay, the
   * same "component wires the toast, the store stays store" split
   * `trashNote`/`restoreNote`'s own callers already draw.
   *
   * `labelContact`/`unlabelContact` are `labelNote`/`unlabelNote`'s own
   * shape: the Label's `name` carried across, its id deterministic
   * (`labels.ts#labelId`) from `(userId, name)` — a Contact's Labels are
   * User-owned exactly like a Note's (CONTEXT.md's own **Label** entry).
   *
   * `setContactBanner` (#212) is the same shape again: a Wicket-only
   * decoration, never part of any Origin's capability table
   * (`contacts.ts#contactBannerSchema`'s own doc comment), so it rides on
   * any Contact regardless of Origin the same way a Label does, rather
   * than through `updateContact` and its `LOCAL_CONTACT_CAPABILITY_TABLE`
   * guard (`sync/mutations.ts`).
   */
  z.object({
    type: z.literal("createContact"),
    contactId: z.string(),
    addressBookId: z.string(),
    fields: contactWritableFieldsSchema,
  }),
  z.object({ type: z.literal("deleteContact"), contactId: z.string() }),
  z.object({
    type: z.literal("updateContact"),
    contactId: z.string(),
    fields: contactWritableFieldsSchema,
  }),
  z.object({ type: z.literal("trashContact"), contactId: z.string() }),
  z.object({ type: z.literal("restoreContact"), contactId: z.string() }),
  z.object({ type: z.literal("labelContact"), contactId: z.string(), name: z.string() }),
  z.object({ type: z.literal("unlabelContact"), contactId: z.string(), name: z.string() }),
  z.object({
    type: z.literal("setContactBanner"),
    contactId: z.string(),
    banner: contactBannerSchema.nullable(),
  }),
  /**
   * Linked Contacts (#222, ADR-0026: "Linked Contacts are a User-scoped
   * link, never a change to any record") — three intents that touch the
   * `ContactLink` collection alone and never a Contact row, which is what
   * makes an unlink able to restore two cards exactly as they were with
   * nothing to reconstruct.
   *
   * `linkContacts`/`unlinkContact` are a genuine inverse pair in ADR-0019's
   * sense — both are real actions on the wire, and either one applied to the
   * other's result returns the User to where they started — without being
   * mirror-image *shapes*: linking names the two records being joined, while
   * unlinking names the one record leaving. That asymmetry is the set model's
   * (`contact-links.ts#contactLinkSchema`: a link is a set, not a pair), and
   * it is why the two sit in separate `coalesceKey` buckets rather than
   * cancelling each other out while still queued
   * (`store/user-mutation-queue.ts`).
   *
   * `linkId` is the Client-minted ULID for the link this may have to create,
   * already known before the intent is enqueued — the same offline-derivable
   * id `createContact`'s own `contactId` is. It is deliberately only a
   * *proposal*: when either side already belongs to a link, the Sync Backend
   * unions into that existing row and this id goes unused
   * (`contacts/link-store.ts#linkContacts`), because the alternative — two
   * links naming the same Contact — is the one state no reader can make
   * sense of.
   *
   * `setLinkedContactFront` is "the User can pick another" (this ticket's own
   * acceptance line): an absolute set on one link, `setContactBanner`'s own
   * latest-pick-wins shape, with `contactId: null` meaning "go back to
   * deriving it" (the Default Address Book, else the most recently edited —
   * `contact-links.ts#resolveLinkedContactFront`).
   */
  z.object({
    type: z.literal("linkContacts"),
    linkId: z.string(),
    contactId: z.string(),
    otherContactId: z.string(),
  }),
  z.object({ type: z.literal("unlinkContact"), contactId: z.string() }),
  z.object({
    type: z.literal("setLinkedContactFront"),
    linkId: z.string(),
    contactId: z.string().nullable(),
  }),
  /**
   * Merge within one Address Book (#223, ADR-0026: "the older record
   * survives and takes the other's fields; the other is deleted") — unlike
   * Linked Contacts above, this one *does* change a Contact row, which is
   * exactly why it is only ever offered for a pair sharing one Address Book
   * (`contact-merge.ts#contactsAreMergeable`): both records already answer
   * to the same capability table, so nothing a real Merge writes can be a
   * field neither record could have held on its own.
   *
   * Unordered, `linkContacts`' own shape: `contactId`/`otherContactId` name
   * the pair, and which one survives is derived identically by the Client
   * and the Sync Backend (`contact-merge.ts#pickContactMergeSurvivor`)
   * rather than picked by whichever side minted the intent — the same
   * "don't trust the wire for something both sides can already compute"
   * posture `linkContacts`' own lowest-id survivor takes. Not a genuine
   * inverse pair the way `createContact`/`deleteContact` is (ADR-0019): a
   * Merge is destructive by design (this ticket's own acceptance line —
   * "the other is deleted"), so it carries no paired undo intent, the same
   * "undoable on the same terms as a delete" its acceptance line asks for,
   * matching `deleteContact`'s own present, un-undoable shape rather than
   * inventing a general reconstruct-a-deleted-row primitive that is #224's
   * own to build.
   */
  z.object({
    type: z.literal("mergeContacts"),
    contactId: z.string(),
    otherContactId: z.string(),
  }),
  /**
   * A Series' structural actions (#233, ADR-0025's Series/Occurrence/Override
   * vocabulary): the same "ordinary Optimistic Action, real inverse"
   * (ADR-0019) shape the Note six above already have — the difference is
   * only that a Series' *body* (title, rules, attendees, description,
   * Location, its Overrides) never rides this queue at all, it rides its own
   * `seriesSaves` channel (`series.ts#seriesSaveSchema`'s own doc comment),
   * the exact split `noteSaveSchema` draws for a Note.
   *
   * `createSeries`/`deleteSeries` are a genuine inverse pair, `createNote`/
   * `deleteNote`'s own shape: `seriesId` is the Client-minted ULID
   * (`series.ts#seriesSchema`'s own doc comment) already known before this
   * intent is ever enqueued, and `deleteSeries` here is the **permanent**
   * delete that undoes a still-queued or already-applied `createSeries` —
   * not the User-facing "Delete" below.
   *
   * `trashSeries`/`restoreSeries` are Delete-a-Series and its Undo: a real
   * inverse pair too, `trashNote`/`restoreNote`'s own shape, except a
   * Series has no Recently Deleted grid to browse — the 24-hour window this
   * ticket's own body promises ("`restoreEvent` recreates a deleted Series
   * from a 24-hour snapshot") is a purge delay exactly like
   * `NOTE_TRASH_RETENTION_DAYS`, just far shorter, and the soft-deleted row
   * itself *is* that snapshot: nothing here diffs or reconstructs a Series,
   * `restoreSeries` only ever clears the same `deletedAt` `trashSeries` set.
   *
   * `addExdate`/`removeExdate` are deleting one Occurrence and its Undo
   * (this ticket's own acceptance line: "Deleting one Occurrence adds an
   * `exdate`; Undo removes it") — a real inverse pair over one RFC 5545
   * date-time string rather than a boolean, since two different Occurrences
   * of the same Series can be deleted independently and each needs its own
   * inverse.
   *
   * `moveSeries` (#238) is Moving an Event between Calendars: "no upstream
   * lets a calendar object change container while keeping identity", so a
   * Move is a copy plus delete with a fresh UID, not an absolute-set
   * `calendarId` field on an existing intent. `newSeriesId` is Client-minted
   * up front, `createSeries`'s own shape, so the destination Series' id is
   * already known before this intent is ever enqueued. There is deliberately
   * no dedicated inverse intent: Undoing a Move is `restoreSeries(seriesId)`
   * (bring the source back) paired with `trashSeries(newSeriesId)` (send the
   * copy away again) — two intents this queue already has real inverses for,
   * rather than a third bespoke "unmove" this queue would need to learn.
   */
  z.object({ type: z.literal("createSeries"), seriesId: z.string(), calendarId: z.string() }),
  z.object({ type: z.literal("deleteSeries"), seriesId: z.string() }),
  z.object({ type: z.literal("trashSeries"), seriesId: z.string() }),
  z.object({ type: z.literal("restoreSeries"), seriesId: z.string() }),
  z.object({ type: z.literal("addExdate"), seriesId: z.string(), exdate: z.iso.datetime() }),
  z.object({ type: z.literal("removeExdate"), seriesId: z.string(), exdate: z.iso.datetime() }),
  z.object({
    type: z.literal("moveSeries"),
    seriesId: z.string(),
    newSeriesId: z.string(),
    calendarId: z.string(),
  }),
  /**
   * A Calendar's own settings sheet (#236, CONTEXT.md's Calendar entry):
   * four independent absolute-set intents, the same "one field, no natural
   * inverse, `coalesceKey` collapses a re-edit" shape `setHomeTimeZone`
   * already takes, rather than one combined "patch" — a User flipping the
   * default Calendar offline and recolouring a different one a moment later
   * are unrelated edits that should never contend for one queue slot.
   *
   * `updateCalendarDetails` is name/description/timeZone together (not
   * three separate intents) because a settings sheet's Save button commits
   * all three as one edit; the server rejects the whole intent when the
   * Calendar isn't `capabilities.writable` (this ticket's "no edit
   * affordances" line — the sheet never offers these fields at all in that
   * case, so this is defense in depth, not the primary guard). Pushing the
   * result upstream for a mirrored Calendar is `fold.ts#capabilitiesFromAccessRole`'s
   * own "write-back itself is #237's" deferral — this intent only ever
   * updates Wicket's own copy.
   *
   * `setCalendarColor` and `setCalendarMailAccount` touch fields that are
   * never pushed upstream at all (colour: CONTEXT.md, seeded once and
   * User-owned from then on; Mail Account: an Organiser identity Wicket
   * alone tracks), so both apply unconditionally regardless of
   * `capabilities.writable`.
   *
   * `setDefaultCalendar` is "the one Calendar across every Origin" (#236) —
   * applying it clears `isDefault` on every other Calendar this User owns
   * in the same transaction, the same "exactly one `true` row" invariant
   * `calendars/store.ts#ensurePersonalCalendar`'s own doc comment names.
   *
   * `setCalendarRemindersEnabled`/`setCalendarReminderDefault` (#244,
   * ADR-0028) join the same four above: two more Wicket-owned fields that
   * never touch the upstream, the same unconditional-of-`writable` posture
   * `setCalendarColor` already has. The Notifications settings page fires
   * the first for any Calendar; `CalendarSettingsSheet.tsx` offers both.
   */
  z.object({
    type: z.literal("updateCalendarDetails"),
    calendarId: z.string(),
    name: z.string().min(1),
    description: z.string().nullable(),
    timeZone: z.string().min(1),
  }),
  z.object({
    type: z.literal("setCalendarColor"),
    calendarId: z.string(),
    color: z.string().min(1),
  }),
  z.object({ type: z.literal("setDefaultCalendar"), calendarId: z.string() }),
  z.object({
    type: z.literal("setCalendarMailAccount"),
    calendarId: z.string(),
    mailAccountId: z.string().nullable(),
  }),
  z.object({
    type: z.literal("setCalendarRemindersEnabled"),
    calendarId: z.string(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("setCalendarReminderDefault"),
    calendarId: z.string(),
    reminderDefault: reminderDefaultSchema,
  }),
  /**
   * The Snooze toast and the Event page (#246, ADR-0028) — the same intent
   * `push.ts#notificationActionIntentSchema`'s `snoozeReminder` carries for
   * the OS notification's button, queued through the ordinary User-scoped
   * Optimistic Action path here instead since the main thread already has
   * one. No inverse: Snooze has nothing to undo back to (the fired Reminder
   * it came from stays fired either way).
   */
  z.object({
    type: z.literal("snoozeReminder"),
    reminderDueIds: z.array(z.string()).min(1),
    snoozeUntil: snoozeUntilSchema,
  }),
]);
export type UserMutationIntent = z.infer<typeof userMutationIntentSchema>;

/** One queued User-scoped Optimistic Action, the same ULID-keyed shape as `QueuedMutation`. */
export const queuedUserMutationSchema = z.object({
  id: z.string(),
  intent: userMutationIntentSchema,
});
export type QueuedUserMutation = z.infer<typeof queuedUserMutationSchema>;

/**
 * The Mail-Account-scoped half of Preferences (#54, plus the remote-images
 * setting #146 grew onto it the same way): the plain-text signature (already
 * a `MailAccount` field, #47), the notification on/off toggle, and the
 * remote-images permission all ride the existing `MailAccount` collection
 * rather than a separate one — one Mail Account, one row, no join needed to
 * render any of them. All three are edited through this Mail Account's
 * ordinary mutation queue — `setSignature`/`setNotificationsEnabled`/
 * `setRemoteImages` on `mutationIntentSchema` below — same as any other App
 * Feature.
 */

/**
 * A Correspondent (#49, CONTEXT.md, compose-spec §Recipient autocomplete):
 * an address the User has actually exchanged mail with on this Mail
 * Account, never hand-edited. `score` is the ranking `sync/correspondents.ts`
 * computed at its last write — sent-weight far above received-weight, with
 * recency decay baked in — and is what the Client sorts its local top ~500
 * by; it is a snapshot, not something a Client ever recomputes itself. Only
 * the top ~500 by score for a Mail Account exist as rows at all
 * (`sync/correspondents.ts#capCorrespondents`), which is what lets this ride
 * the ordinary full-collection sync every Label does rather than needing its
 * own top-K windowing protocol.
 */
export const correspondentSchema = z.object({
  id: z.string(),
  mailAccountId: z.string(),
  address: z.string(),
  /** The best-known display name, or null if this Correspondent has never been seen with one. */
  name: z.string().nullable(),
  sentCount: z.int(),
  receivedCount: z.int(),
  lastSeenAt: z.iso.datetime(),
  score: z.number(),
  updatedAt: z.iso.datetime(),
});
export type Correspondent = z.infer<typeof correspondentSchema>;

export const correspondentDeltaSchema = collectionDeltaSchema(correspondentSchema);
export type CorrespondentDelta = z.infer<typeof correspondentDeltaSchema>;

/**
 * `GET /correspondents/search`'s response (compose-spec: "queries the
 * backend in parallel for the long tail") — the Client's synced top ~500 is
 * `Correspondent` above; this is the plain fetch-through read over every
 * Correspondent this Mail Account has ever had, for a query the local set
 * misses.
 */
export const correspondentSearchResponseSchema = z.object({
  correspondents: z.array(correspondentSchema),
});
export type CorrespondentSearchResponse = z.infer<typeof correspondentSearchResponseSchema>;

/**
 * `Composition` (#46, ADR-0007): Drafts and Pending Sends, per Mail Account.
 * The collection exists so a Pending Send's countdown is "visible and
 * cancellable from every device the User has open" — see
 * `compose.ts#compositionSchema` for why the whole document rides it rather
 * than the send state alone.
 */
export const compositionDeltaSchema = collectionDeltaSchema(compositionSchema);
export type CompositionDelta = z.infer<typeof compositionDeltaSchema>;

/** `ConnectedAccount` (#200, ADR-0023): whole-replicated, User-scoped — see `connected-accounts.ts#connectedAccountSchema`'s own doc comment. */
export const connectedAccountDeltaSchema = collectionDeltaSchema(connectedAccountSchema);
export type ConnectedAccountDelta = z.infer<typeof connectedAccountDeltaSchema>;

/** `AddressBook` (#209, ADR-0023, ADR-0026): whole-replicated, riding the User scope (the Local Address Book) or a Connected Account's own scope (a mirrored one) — see `address-books.ts#addressBookSchema`'s own doc comment. */
export const addressBookDeltaSchema = collectionDeltaSchema(addressBookSchema);
export type AddressBookDelta = z.infer<typeof addressBookDeltaSchema>;

/** `Contact` (#209, ADR-0023, ADR-0026): `AddressBookDelta`'s sibling, same two scopes. */
export const contactDeltaSchema = collectionDeltaSchema(contactSchema);
export type ContactDelta = z.infer<typeof contactDeltaSchema>;

/**
 * `ContactLink` (#222, ADR-0026): whole-replicated and **User-scoped only**
 * — unlike `AddressBook`/`Contact` above, which ride two scopes, a link
 * spans Origins by construction and so belongs to no Connected Account's
 * Sync Scope at all (`contact-links.ts#contactLinkSchema`'s own doc
 * comment).
 */
export const contactLinkDeltaSchema = collectionDeltaSchema(contactLinkSchema);
export type ContactLinkDelta = z.infer<typeof contactLinkDeltaSchema>;

/**
 * A requested collection's token. `null` asks for a full bootstrap (the
 * Client holds nothing yet — not the same as a stale/unrecognized token,
 * which the server can also answer with `reset: true`); omitting the key
 * entirely means "I'm not asking about this collection at all".
 */
const requestedTokenSchema = z.string().nullable();

export const userSyncRequestSchema = z.object({
  MailAccount: requestedTokenSchema.optional(),
  Preference: requestedTokenSchema.optional(),
  /** `Label` (#186): User-scoped, one set spanning every Mail Account. */
  Label: requestedTokenSchema.optional(),
  /** `Note` (#192, ADR-0023): whole-replicated, User-scoped. */
  Note: requestedTokenSchema.optional(),
  /** `ConnectedAccount` (#200, ADR-0023): whole-replicated, User-scoped. */
  ConnectedAccount: requestedTokenSchema.optional(),
  /** `AddressBook` (#209, ADR-0023): the Local Address Book's own slot — a mirrored one rides its Connected Account's slot instead (`connectedAccountSyncRequestSchema`). */
  AddressBook: requestedTokenSchema.optional(),
  /** `Contact` (#209, ADR-0023): `AddressBook`'s sibling — Local Contacts only, same reasoning. */
  Contact: requestedTokenSchema.optional(),
  /** `ContactRollback` (#216): `contacts.ts#contactRollbackSchema`'s own doc comment — append-only, User-scoped regardless of which Connected Account the write concerned. */
  ContactRollback: requestedTokenSchema.optional(),
  /** `ContactLink` (#222, ADR-0026): User-scoped whole and entire, mirrored or not — see `contactLinkDeltaSchema`. */
  ContactLink: requestedTokenSchema.optional(),
  /**
   * `Calendar` (#229): whole-replicated, User-scoped on this line — a
   * genuine `connectedAccount`-scoped sync path
   * (`sync/collection-registry.ts#ScopeKind`'s own doc comment) is future
   * work this recovery deliberately did not build; see this repo's
   * recovery notes for why.
   */
  Calendar: requestedTokenSchema.optional(),
  /** `Event` (#229): the windowed collection, User-scoped on this line — see the `Calendar` entry above. */
  Event: requestedTokenSchema.optional(),
  /** `Rollback` (#229, ADR-0025): whole-replicated, User-scoped — always empty until #237's write-back. */
  Rollback: requestedTokenSchema.optional(),
  /** This User's queue to flush, oldest first — see `queuedUserMutationSchema`. */
  mutations: z.array(queuedUserMutationSchema).optional(),
  /**
   * Note body autosaves to flush (#192, ADR-0023, `notes.ts#noteSaveSchema`)
   * — a *separate* array from `mutations` above, not a `UserMutationIntent`
   * variant, because it coalesces (last-write-wins per Note) rather than
   * draining FIFO. `composeSaves`'s User-scoped sibling: at most one entry
   * per Note per round, since `store/notes.ts`'s coalescing queue holds only
   * the latest save.
   */
  noteSaves: z.array(noteSaveSchema).optional(),
  /**
   * Series body autosaves to flush (#233, `series.ts#seriesSaveSchema`) —
   * `noteSaves`' own sibling channel, at most one entry per Series per round
   * (`store/series.ts`'s coalescing queue never holds more than that).
   */
  seriesSaves: z.array(seriesSaveSchema).optional(),
});
export type UserSyncRequest = z.infer<typeof userSyncRequestSchema>;

/**
 * A semantic Optimistic Action (ADR-0010, #39) — never a wire-level
 * operation, so a protocol change never invalidates a queued action still
 * sitting in a Client's Local Cache. Additive: a future `pin`/`label`
 * intent is a new union member, never a reshape of these four.
 *
 * `setStarred`/`setRead` apply to *every* Message in the Thread — the same
 * "whole Thread" granularity `sync/thread-rollup.ts` already aggregates
 * over, so the optimistic overlay's predicted `unreadCount`/`starred`
 * matches exactly what the backend will compute once the intent lands.
 *
 * `archive`/`trash` (#42) are one-directional — there is no `unarchive`
 * intent yet, so unlike the two above they never coalesce with anything in
 * `store/mutation-queue.ts`. Applying one flips the Thread's `inInbox` to
 * `false` and, asynchronously, moves whatever of its Messages sit in the
 * Inbox to the account's Archive/Trash folder over real IMAP (ADR-0006).
 *
 * `snooze` (#76, CONTEXT.md's Snooze entry) is a third one-directional
 * Thread-hiding intent, same shape as `archive`/`trash` and never
 * coalescing with anything either — but, being an App Feature (ADR-0006), it
 * never enqueues a protocol write: `until` only ever moves the Thread row's
 * own `snoozeUntil`/`inInbox` fields, and the Sync Backend's own wake sweep
 * (not a Client-sent intent) is what clears them again once `until` passes.
 *
 * `setPinned` (#43) mirrors `setStarred`'s absolute-set shape exactly, but
 * — Pin being an App Feature (ADR-0006) — never enqueues a protocol write:
 * it touches only the Thread row, never a Message's flags.
 *
 * `applyLabel`/`removeLabel` (#43) carry the Label's `name`, not its id: the
 * id is deterministic (`labelId` in `packages/shared/src/labels.ts`) from
 * `(mailAccountId, name)`, so both the Client's optimistic overlay
 * (`store/reads.ts`) and the Sync Backend derive the same id independently
 * rather than one minting it and handing it to the other. Applying a name
 * with no existing Label creates one; removing a name with no effect is a
 * harmless no-op, the same tolerance `archive`/`trash` already have for a
 * Thread that's already in the state being asked for.
 *
 * `sendComposition`/`cancelSend` (#46) are the first intents that name a
 * Composition rather than a Thread. They ride this queue rather than a
 * dedicated route because ADR-0014 says so directly — "an offline send
 * queues, and says so ... it becomes a Pending Send intent, and the Undo
 * Send countdown starts only when the Sync Backend accepts it" — which is
 * exactly the durable, offline-survivable, idempotent-by-id delivery the
 * queue already provides. Neither carries a delay: `submit_after` is the
 * server's to compute from the User's own preference, because ADR-0007
 * measures the delay "from server receipt, never from the Client's clock".
 * `cancelSend` is the one intent whose rejection is a *normal* outcome the
 * User must be told about: a cancel that arrives after
 * `compose/pending-send.ts`'s atomic claim is rejected `too_late`
 * (ADR-0007: "a cancel arriving after the claim loses and is reported to
 * the User as too late").
 *
 * `setSignature`/`setNotificationsEnabled`/`setRemoteImages` (#54, #146) are
 * the Mail-Account-scoped half of Preferences — see the docstring above for
 * why they ride this queue rather than a new collection.
 *
 * The Gatekeeper intents (#55, #102) are the Screener's decisions and the
 * Blocked Senders list's undo. They ride this queue rather than their own
 * routes because CONTEXT.md files "approve/block senders" under **Triage**:
 * they are decisions the User makes while processing the list, and they want
 * the same durable, offline-survivable, ULID-idempotent delivery every other
 * triage action has. Each names a *sender* (an address, or a whole domain as
 * poc-spec.md's overflow convenience), never a Thread — one decision per
 * stranger, not per message — and each acts on every Thread that sender is
 * currently holding:
 *
 * - `approveSender` releases them with their original received dates and
 *   records an Approved Verdict, which is also the image-loading permission
 *   (`poc-scope.md`: "the Gatekeeper verdict *is* the image-loading
 *   permission").
 * - `denySender` trashes the held Threads and leaves the sender
 *   **Unscreened** — the next message from them is held again.
 * - `blockSender` trashes them and records a Blocked Verdict, after which
 *   every future arrival is moved to the real `\\Trash` folder on arrival
 *   (ADR-0008). It is the sole off-switch for an Approved sender. `sender`
 *   is usually `address`/`domain`-scoped, but #103's Blocked Alias rides the
 *   same intent at `scope: "recipient"` — the Screener's *Block everything
 *   sent to `<alias>`* — with one difference: it names a Thread's recipient
 *   Alias, not its sender, and it is refused (`rejected`, same shape as a
 *   barred domain) if that Alias is the Mail Account's own primary address.
 * - `spamSender` (#102, CONTEXT.md's Spam, ADR-0008's amendment) does exactly
 *   what `blockSender` does, plus one thing: held and future mail move to the
 *   Mail Account's Junk folder instead of Trash, so the provider's own filter
 *   learns from it. The Screener's Block split menu offers it as a deliberate
 *   extra click, never the default — "I don't want this" and "this is spam"
 *   are different claims.
 * - `unblockSender` clears a Blocked (or Spam) Verdict back to Unscreened.
 *   Future-only by construction: ADR-0008 is explicit that unblocking "stops
 *   the bleeding but recovers nothing".
 *
 * `approveSender`/`blockSender`/`spamSender`'s optional `threadId` (#144:
 * Spam, Approve and Block on any Inbox Thread) names one specific Thread the
 * decision must act on, alongside whatever the sender happens to be holding
 * (nothing, ordinarily, since an Inbox Thread was by definition never held).
 * These three are otherwise unchanged: still one decision per *sender*, and
 * still correct for a stranger who has three other Threads sitting in the
 * Screener at the same moment. The Verdict they record takes effect
 * regardless of whether Gatekeeper is even enabled for the Mail Account,
 * exactly as it would for a seeded or Screener decision.
 *
 * A domain-scoped intent for a public provider (`gatekeeper.ts`'s
 * `BARRED_VERDICT_DOMAINS`) is `rejected` rather than silently downgraded to
 * an address — the Client should never have offered the button, and a
 * rejection says so.
 *
 * `restoreToInbox`/`unsnooze`/`unblockAndRestore` (#95, ADR-0019) are Undo's
 * own real inverses, never a queue cancellation — an enqueued inverse is
 * exactly what the Undo toast sends, whether or not the original it reverses
 * has already been flushed. `restoreToInbox` undoes `archive` *or* `trash`
 * (an IMAP move back out of Archive/Trash) and is also what a Screener
 * Approve already does to a held Thread — `sync/mutations.ts` reuses that
 * same restore step. `unsnooze` undoes `snooze` the same App-Feature way
 * Pin's own toggle works: no protocol write, just the Thread row. Both name
 * one Thread, exactly like the actions they reverse, which is what lets
 * `store/mutation-queue.ts`'s coalescer cancel a still-queued original for
 * free. `unblockAndRestore` undoes Deny, Block, Spam, **or** #103's
 * Block-Alias: `sender` is who (or, at `scope: "recipient"`, which Alias)
 * the Verdict-clear targets (a no-op for Deny, which left none, and the
 * one call that also drops Spam's `spam` flag, since it deletes the whole
 * row), and `threadIds` — captured by the Client at decision time, the same
 * way `ScreenerSenderGroup.threadIds` already is — names exactly the Threads
 * that decision trashed *or moved to Junk*, since by the time Undo fires the
 * sender (or Alias) may be holding a fresh, unrelated stranger's mail again.
 * `restoreThreadsToInbox` (`sync/restore-to-inbox.ts`) is what actually
 * widened to bring a Thread back out of Junk, not a new field here — Spam
 * rides this exact intent rather than one of its own, because a Spam
 * Verdict *is* a Blocked Verdict (`spam: true` alongside it) for every other
 * purpose one answers, and undoing it is "clear the Verdict, restore the
 * Threads" either way. The payload grows no new field for Block-Alias:
 * `sender` at `scope: "recipient"` is already what `blockSender` used to
 * create the Verdict, so undoing it is the exact
 * same `clearVerdict` call `address`/`domain` scopes already get.
 *
 * `discardComposition`/`undiscardComposition` (#101, ADR-0012's "deletion is
 * asymmetric") are Delete's own pair, the same shape `sendComposition`/
 * `cancelSend` already have: name a Composition, not a Thread, ride this
 * queue for its offline-survivable idempotent delivery, and dispatch through
 * `sync/mutations.ts#applyCompositionIntent`. `discardComposition` marks a
 * `draft`-status Composition `discarded` (rejecting anything else as
 * `not_a_draft`), drops its attachment blobs synchronously, and lets the
 * debounced push loop (`sync/draft-push.ts`) expunge the IMAP Drafts copy
 * asynchronously, on its own interval — the same "never a user-visible
 * error, always eventually consistent" posture the push itself already has.
 * `undiscardComposition` is Undo's real inverse (#95, ADR-0019): restores
 * `draft`, and — because the expunge may not have run yet — leaves the
 * pushed-content bookkeeping alone, so a fast Undo costs the IMAP side
 * nothing at all, and only a slow one (past the expunge) triggers the next
 * push loop tick to re-export it.
 */
export const mutationIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setStarred"), threadId: z.string(), starred: z.boolean() }),
  z.object({ type: z.literal("setRead"), threadId: z.string(), read: z.boolean() }),
  z.object({ type: z.literal("archive"), threadId: z.string() }),
  z.object({ type: z.literal("trash"), threadId: z.string() }),
  z.object({ type: z.literal("snooze"), threadId: z.string(), until: z.iso.datetime() }),
  z.object({ type: z.literal("restoreToInbox"), threadId: z.string() }),
  z.object({ type: z.literal("unsnooze"), threadId: z.string() }),
  z.object({ type: z.literal("setPinned"), threadId: z.string(), pinned: z.boolean() }),
  z.object({ type: z.literal("applyLabel"), threadId: z.string(), name: z.string() }),
  z.object({ type: z.literal("removeLabel"), threadId: z.string(), name: z.string() }),
  z.object({ type: z.literal("sendComposition"), compositionId: z.string() }),
  z.object({ type: z.literal("cancelSend"), compositionId: z.string() }),
  z.object({ type: z.literal("discardComposition"), compositionId: z.string() }),
  z.object({ type: z.literal("undiscardComposition"), compositionId: z.string() }),
  z.object({ type: z.literal("setSignature"), signature: z.string().nullable() }),
  z.object({ type: z.literal("setNotificationsEnabled"), enabled: z.boolean() }),
  z.object({ type: z.literal("setRemoteImages"), value: remoteImagesSettingSchema }),
  z.object({
    type: z.literal("approveSender"),
    sender: gatekeeperSenderSchema,
    /**
     * Present only when this decision was reached for one specific Inbox
     * Thread rather than from the Screener (#144: Spam/Approve/Block on any
     * Inbox Thread) — `sync/mutations.ts#applyGatekeeperIntent`'s own
     * doc comment says what each of the three does with it.
     */
    threadId: z.string().optional(),
  }),
  z.object({ type: z.literal("denySender"), sender: gatekeeperSenderSchema }),
  z.object({
    type: z.literal("blockSender"),
    sender: gatekeeperSenderSchema,
    threadId: z.string().optional(),
  }),
  z.object({
    type: z.literal("spamSender"),
    sender: gatekeeperSenderSchema,
    threadId: z.string().optional(),
  }),
  z.object({ type: z.literal("unblockSender"), sender: gatekeeperSenderSchema }),
  z.object({
    type: z.literal("unblockAndRestore"),
    sender: gatekeeperSenderSchema,
    threadIds: z.array(z.string()),
  }),
]);
export type MutationIntent = z.infer<typeof mutationIntentSchema>;

/**
 * One queued Optimistic Action as it rides the wire: `id` is the
 * Client-generated ULID idempotency key (ADR-0010), echoed back verbatim in
 * the matching `MutationOutcome`. A Mail Account's array is sent, and must
 * be applied, in **strict FIFO order** — the array's order *is* the queue's
 * order, never re-derived from a timestamp on the server side.
 */
export const queuedMutationSchema = z.object({
  id: z.string(),
  intent: mutationIntentSchema,
});
export type QueuedMutation = z.infer<typeof queuedMutationSchema>;

/**
 * One mutation's outcome (ADR-0011's third divergence: a mutation-flush
 * response carries deltas back in the same round trip). `applied` covers
 * both "just applied" and "already applied — this id was a retry", so the
 * Client always dequeues on it; `rejected` is permanent and is never
 * retried by the Client (a transient failure never reaches this shape at
 * all — it fails the whole `POST /sync` instead, per the ordinary
 * network-error/backoff path).
 */
export const mutationOutcomeSchema = z.object({
  id: z.string(),
  status: z.enum(["applied", "rejected"]),
  reason: z.string().optional(),
});
export type MutationOutcome = z.infer<typeof mutationOutcomeSchema>;

export const mailAccountSyncRequestSchema = z.object({
  Thread: requestedTokenSchema.optional(),
  GmailLabel: requestedTokenSchema.optional(),
  Composition: requestedTokenSchema.optional(),
  Correspondent: requestedTokenSchema.optional(),
  /** This account's queue to flush, oldest first. Omitted (never `[]`) when there is nothing queued for it. */
  mutations: z.array(queuedMutationSchema).optional(),
  /**
   * Composition autosaves to flush (ADR-0014, `compose.ts`) — a *separate*
   * array from `mutations` above, not a `MutationIntent` variant, because it
   * coalesces (last-write-wins per Composition) rather than draining FIFO.
   * At most one entry per Composition per round: `store/compositions.ts`'s
   * coalescing queue holds only the latest save.
   */
  composeSaves: z.array(composeSaveSchema).optional(),
});
export type MailAccountSyncRequest = z.infer<typeof mailAccountSyncRequestSchema>;

/**
 * The Connected-Account-scoped slot (#209, ADR-0023: "a `connectedAccounts`
 * sibling appears when the first Connected-Account-scoped collection
 * does") — `AddressBook`/`Contact`'s first real user of `scopeKind:
 * "connectedAccount"`, the branch `collection-registry.ts` declared as a
 * documented no-op until now. No `mutations`/`composeSaves` yet: nothing
 * writes back to a mirrored Address Book or Contact in this ticket (no
 * upstream adapter exists yet, #214+), so there is nothing here to flush.
 */
export const connectedAccountSyncRequestSchema = z.object({
  AddressBook: requestedTokenSchema.optional(),
  Contact: requestedTokenSchema.optional(),
});
export type ConnectedAccountSyncRequest = z.infer<typeof connectedAccountSyncRequestSchema>;

export const syncRequestSchema = z.object({
  /** User-scoped collections. */
  user: userSyncRequestSchema.optional(),
  /** Per-Mail-Account collections, keyed by Mail Account id. */
  mailAccounts: z.record(z.string(), mailAccountSyncRequestSchema).optional(),
  /** Per-Connected-Account collections, keyed by Connected Account id (#209). */
  connectedAccounts: z.record(z.string(), connectedAccountSyncRequestSchema).optional(),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

/**
 * Mirrors the request, one level per scope. A collection is present in the
 * response only when something actually changed for it since the token the
 * Client sent — "unchanged collections return no payload" (#37) — so an
 * all-quiet poll answers with `{ user: {}, mailAccounts: {} }`. `mutations`
 * follows the same rule but on a different trigger: present whenever the
 * request carried mutations to flush for that account, regardless of
 * whether the Thread delta itself is non-empty (an idempotent replay can
 * report `applied` with no further Thread change at all).
 */
export const userSyncResponseSchema = z.object({
  MailAccount: mailAccountDeltaSchema.optional(),
  Preference: preferenceDeltaSchema.optional(),
  Label: labelDeltaSchema.optional(),
  Note: noteDeltaSchema.optional(),
  ConnectedAccount: connectedAccountDeltaSchema.optional(),
  /** `AddressBook` (#209): the Local Address Book only — see `userSyncRequestSchema`'s own field. */
  AddressBook: addressBookDeltaSchema.optional(),
  /** `Contact` (#209): `AddressBook`'s sibling — Local Contacts only. */
  Contact: contactDeltaSchema.optional(),
  /** `ContactRollback` (#216) — `contacts.ts#contactRollbackSchema`'s own doc comment. */
  ContactRollback: contactRollbackDeltaSchema.optional(),
  /** `ContactLink` (#222): User-scoped only — see `userSyncRequestSchema`'s own field. */
  ContactLink: contactLinkDeltaSchema.optional(),
  Calendar: calendarDeltaSchema.optional(),
  Event: eventDeltaSchema.optional(),
  Rollback: rollbackDeltaSchema.optional(),
  /** Outcomes in the same order as the request's `mutations` array. */
  mutations: z.array(mutationOutcomeSchema).optional(),
  /** Outcomes in the same order as the request's `noteSaves` array. */
  noteSaves: z.array(noteSaveOutcomeSchema).optional(),
  /** Outcomes in the same order as the request's `seriesSaves` array (#233). */
  seriesSaves: z.array(seriesSaveOutcomeSchema).optional(),
  /**
   * The app-icon badge (#53, ADR-0015): unread Inbox threads across every
   * Mail Account, Gatekeeper-held mail never counted. The real server always
   * sends this — unlike the collections above it is never gated on
   * "something changed", since the leader tab snaps the badge to it on
   * every round and the visibility-change round that "snaps the badge true"
   * after a quiet gap depends on that being unconditional rather than riding
   * some other collection's delta. Optional on the wire schema only for the
   * same additive-only reason every field here is (a fixture/older response
   * with no opinion on the badge simply leaves it alone).
   */
  unreadInboxCount: z.int().optional(),
});
export type UserSyncResponse = z.infer<typeof userSyncResponseSchema>;

export const mailAccountSyncResponseSchema = z.object({
  Thread: threadDeltaSchema.optional(),
  GmailLabel: gmailLabelDeltaSchema.optional(),
  Composition: compositionDeltaSchema.optional(),
  Correspondent: correspondentDeltaSchema.optional(),
  /** Outcomes in the same order as the request's `mutations` array. */
  mutations: z.array(mutationOutcomeSchema).optional(),
  /** Outcomes in the same order as the request's `composeSaves` array. */
  composeSaves: z.array(composeSaveOutcomeSchema).optional(),
});
export type MailAccountSyncResponse = z.infer<typeof mailAccountSyncResponseSchema>;

/** `connectedAccountSyncRequestSchema`'s answer — `mailAccountSyncResponseSchema`'s sibling, minus mutations/composeSaves (#209's own doc comment on the request side). */
export const connectedAccountSyncResponseSchema = z.object({
  AddressBook: addressBookDeltaSchema.optional(),
  Contact: contactDeltaSchema.optional(),
});
export type ConnectedAccountSyncResponse = z.infer<typeof connectedAccountSyncResponseSchema>;

export const syncResponseSchema = z.object({
  user: userSyncResponseSchema,
  mailAccounts: z.record(z.string(), mailAccountSyncResponseSchema),
  connectedAccounts: z.record(z.string(), connectedAccountSyncResponseSchema),
});
export type SyncResponse = z.infer<typeof syncResponseSchema>;
