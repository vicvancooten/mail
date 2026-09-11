import type { MutationOutcome, UserMutationIntent } from "@mail/shared";
import { normalizeLabelName } from "@mail/shared";
import { requestSyncNow } from "../sync/sync-loop.js";
import type { PendingUserMutation } from "./db.js";
import { localCache } from "./local-cache.js";
import { generateUlid } from "./ulid.js";

/**
 * The User-scoped Optimistic Action queue's only writers (#54), mirroring
 * `mutation-queue.ts`'s split for the per-Mail-Account queue: components
 * enqueue a `Preference` edit — or, since #192, a Note structural intent —
 * here, `sync/` is the only reader that flushes and dequeues it. There is no
 * `mailAccountId`/`referencedThreadIds` to carry — nothing here is ever about
 * a Thread, and Needs Reauth (a Mail Account concept) never applies to a
 * User-scoped edit.
 *
 * Two coalescing shapes share one queue, told apart by `coalesceKey` below:
 * a `Preference` field is an absolute set with no natural inverse, so a
 * second edit to the same field while the first is still queued **replaces**
 * it outright — "the User changed their mind again before it went out". A
 * Note structural intent (#192, ADR-0019) *does* have a real inverse
 * (`createNote`/`deleteNote`, `labelNote`/`unlabelNote`), so a still-queued
 * original meeting its own inverse **cancels both away** instead — the same
 * trick `mutation-queue.ts#enqueueMutation` already plays for the
 * per-Thread queue, generalized here to whichever of the two a given intent
 * kind calls for.
 *
 * Wakes the sync loop (`requestSyncNow`, `sync/sync-loop.ts`) once the row
 * lands — ADR-0011: flushing the queue and syncing are one round trip, and
 * an Optimistic Action confirms "without waiting for the next poll", not up
 * to 30s later on the ordinary interval. Called even on the cancelled-away
 * path: there is nothing new to flush, but a still-queued original this
 * cancelled may itself be worth flushing sooner (harmless, `requestSyncNow`
 * is idempotent either way).
 */

/**
 * What "about the same thing" means for one intent (the grouping key a
 * later edit/inverse is matched against) — every `Preference` field gets a
 * fixed, type-only key (there is exactly one of each per User, so `type`
 * alone is a unique enough bucket); a Note intent's key names the Note (and,
 * for a Label, the normalized name too), the same per-entity granularity
 * `mutation-queue.ts#coalesceKey` uses for a Thread.
 */
function coalesceKey(intent: UserMutationIntent): {
  type: string;
  targetId: string;
  value: boolean;
} {
  switch (intent.type) {
    case "setAutoAdvance":
    case "setUndoSendDelay":
    case "setHomeTimeZone":
    case "setContactsSortOrder":
    case "setAnswerNotificationsEnabled":
      return { type: intent.type, targetId: intent.type, value: true };
    // The Default Address Book (#211): the same "absolute set, latest pick
    // wins" shape as the `Preference` fields above — a second pick before
    // the first ever reaches the Sync Backend simply replaces it, keyed on
    // a fixed bucket since a User has exactly one default at a time.
    case "setDefaultAddressBook":
      return { type: "defaultAddressBook", targetId: "defaultAddressBook", value: true };
    // `createNote`/`deleteNote` (#192, ADR-0019) are a genuine inverse pair,
    // the same shape `mutation-queue.ts`'s `discardComposition`/
    // `undiscardComposition` bucket already has.
    case "createNote":
      return { type: "note", targetId: intent.noteId, value: true };
    case "deleteNote":
      return { type: "note", targetId: intent.noteId, value: false };
    // `labelNote`/`unlabelNote` (#192) share one bucket keyed on
    // `noteId:name`, the same `applyLabel`/`removeLabel` shape
    // `mutation-queue.ts`'s own `"label"` bucket already has.
    case "labelNote":
      return {
        type: "noteLabel",
        targetId: `${intent.noteId}:${normalizeLabelName(intent.name)}`,
        value: true,
      };
    case "unlabelNote":
      return {
        type: "noteLabel",
        targetId: `${intent.noteId}:${normalizeLabelName(intent.name)}`,
        value: false,
      };
    // `pinNote`/`unpinNote` (#193) are a genuine inverse pair too, the same
    // `"note"` bucket shape `createNote`/`deleteNote` above already have,
    // just keyed into their own bucket so a still-queued `pinNote` never
    // cancels away an unrelated `createNote`/`deleteNote` for the same Note.
    case "pinNote":
      return { type: "notePin", targetId: intent.noteId, value: true };
    case "unpinNote":
      return { type: "notePin", targetId: intent.noteId, value: false };
    // `trashNote`/`restoreNote` (#194) are a genuine inverse pair too, the
    // same `"note"` bucket shape `createNote`/`deleteNote` above already
    // have, just keyed into their own bucket so a still-queued `trashNote`
    // never cancels away an unrelated `pinNote`/`unpinNote` (or vice versa)
    // for the same Note.
    case "trashNote":
      return { type: "noteTrash", targetId: intent.noteId, value: true };
    case "restoreNote":
      return { type: "noteTrash", targetId: intent.noteId, value: false };
    // `createContact`/`deleteContact` (#210) are a genuine inverse pair,
    // `createNote`/`deleteNote`'s own shape.
    case "createContact":
      return { type: "contact", targetId: intent.contactId, value: true };
    case "deleteContact":
      return { type: "contact", targetId: intent.contactId, value: false };
    // `updateContact` (#210) has no fixed paired inverse type — a second
    // edit to the same Contact while one is still queued **replaces** it
    // outright, the same `"the User changed their mind again"` shape the
    // `Preference` variants above already have, keyed into its own bucket so
    // it never cancels away an unrelated `createContact`/`deleteContact` for
    // the same Contact.
    case "updateContact":
      return { type: "contactUpdate", targetId: intent.contactId, value: true };
    // `labelContact`/`unlabelContact` (#210) share one bucket keyed on
    // `contactId:name`, `labelNote`/`unlabelNote`'s own shape.
    case "labelContact":
      return {
        type: "contactLabel",
        targetId: `${intent.contactId}:${normalizeLabelName(intent.name)}`,
        value: true,
      };
    case "unlabelContact":
      return {
        type: "contactLabel",
        targetId: `${intent.contactId}:${normalizeLabelName(intent.name)}`,
        value: false,
      };
    // `setContactBanner` (#212) is `updateContact`'s own "latest pick wins"
    // shape — an absolute set with no paired inverse, keyed into its own
    // bucket so it never cancels away an unrelated `createContact`/
    // `deleteContact` or `updateContact` for the same Contact.
    case "setContactBanner":
      return { type: "contactBanner", targetId: intent.contactId, value: true };
    // `trashContact`/`restoreContact` (#224) are a genuine inverse pair too,
    // `trashNote`/`restoreNote`'s own shape — keyed into their own bucket so
    // a still-queued `trashContact` never cancels away an unrelated
    // `updateContact`/`labelContact` (or vice versa) for the same Contact.
    case "trashContact":
      return { type: "contactTrash", targetId: intent.contactId, value: true };
    case "restoreContact":
      return { type: "contactTrash", targetId: intent.contactId, value: false };
    // Linked Contacts (#222, ADR-0026). `linkContacts` keys on the **pair**,
    // unordered, so re-linking the same two records while the first is still
    // queued replaces it rather than queueing a second no-op;
    // `unlinkContact` keys on the one record leaving. Deliberately separate
    // buckets rather than one cancel-pair: the two intents are genuine
    // inverses in effect but not in shape (a link names two records, an
    // unlink names one — `@mail/shared#userMutationIntentSchema`'s own doc
    // comment on why the set model makes that asymmetry unavoidable), so
    // there is no single `targetId` both could agree on without one of them
    // lying about what it targets. Both are real actions on the wire either
    // way, which is what ADR-0019 actually asks for.
    case "linkContacts":
      return {
        type: "contactLink",
        targetId: [intent.contactId, intent.otherContactId].sort().join(":"),
        value: true,
      };
    case "unlinkContact":
      return { type: "contactUnlink", targetId: intent.contactId, value: true };
    // `setLinkedContactFront` (#222) is `setContactBanner`'s own absolute-set
    // shape, keyed on the link so a second pick before the first goes out
    // simply replaces it.
    case "setLinkedContactFront":
      return { type: "contactLinkFront", targetId: intent.linkId, value: true };
    // Merge within one Address Book (#223) — `linkContacts`' own
    // unordered-pair bucket: re-merging the same two records while the first
    // is still queued replaces it rather than queueing a second no-op. Never
    // in the same bucket as `contactLink`'s own — a duplicate offers either
    // Merge or Link, never both, so the two can't collide in practice, but
    // keeping them apart means neither could ever be misread as the other's
    // inverse if that changed.
    case "mergeContacts":
      return {
        type: "contactMerge",
        targetId: [intent.contactId, intent.otherContactId].sort().join(":"),
        value: true,
      };
    // `createSeries`/`deleteSeries` (#233) are a genuine inverse pair, the
    // same `"note"`-bucket shape `createNote`/`deleteNote` already have.
    case "createSeries":
      return { type: "series", targetId: intent.seriesId, value: true };
    case "deleteSeries":
      return { type: "series", targetId: intent.seriesId, value: false };
    // `trashSeries`/`restoreSeries` (#233) mirror `trashNote`/`restoreNote`'s
    // own bucket shape, keyed separately so a still-queued `trashSeries`
    // never cancels away an unrelated `createSeries`/`deleteSeries`.
    case "trashSeries":
      return { type: "seriesTrash", targetId: intent.seriesId, value: true };
    case "restoreSeries":
      return { type: "seriesTrash", targetId: intent.seriesId, value: false };
    // `addExdate`/`removeExdate` (#233) are keyed on `seriesId:exdate` — two
    // different Occurrences of the same Series are deleted (and undone)
    // independently, the same per-value granularity `labelNote`/`unlabelNote`
    // already have for a Label's `name`.
    case "addExdate":
      return { type: "exdate", targetId: `${intent.seriesId}:${intent.exdate}`, value: true };
    case "removeExdate":
      return { type: "exdate", targetId: `${intent.seriesId}:${intent.exdate}`, value: false };
    // `moveSeries` (#238) has no natural inverse of its own — undoing it is
    // `restoreSeries`/`trashSeries` on two different Series ids
    // (`sync.ts#userMutationIntentSchema`'s own doc comment), which already
    // coalesce through the `"seriesTrash"` bucket above. Keyed on `seriesId`
    // alone, its own bucket, so re-picking a different destination before the
    // first Move flushes simply replaces it rather than queuing two.
    case "moveSeries":
      return { type: "seriesMove", targetId: intent.seriesId, value: true };
    // A Calendar's settings sheet (#236): each of the four fields is its own
    // absolute set with no natural inverse, the same `setAutoAdvance`-style
    // bucket shape above — keyed per-Calendar-per-field so an edit to one
    // Calendar's colour never supersedes another Calendar's still-queued
    // name change.
    case "updateCalendarDetails":
      return { type: "calendarDetails", targetId: intent.calendarId, value: true };
    case "setCalendarColor":
      return { type: "calendarColor", targetId: intent.calendarId, value: true };
    case "setDefaultCalendar":
      return { type: "calendarDefault", targetId: intent.calendarId, value: true };
    case "setCalendarMailAccount":
      return { type: "calendarMailAccount", targetId: intent.calendarId, value: true };
    // Reminder settings (#244, ADR-0028) — the same per-Calendar-per-field
    // bucket shape as the four above.
    case "setCalendarRemindersEnabled":
      return { type: "calendarRemindersEnabled", targetId: intent.calendarId, value: true };
    case "setCalendarReminderDefault":
      return { type: "calendarReminderDefault", targetId: intent.calendarId, value: true };
    // Snoozing a fired Reminder (#246, ADR-0028) has no natural inverse —
    // nothing to undo back to, the fired row it came from stays fired
    // either way — so this is the same absolute-set bucket shape
    // `setAutoAdvance` above takes, keyed on the joined ids so tapping a
    // different Snooze length twice in a row (a mis-tap, a change of mind)
    // replaces the still-queued one rather than sending both.
    case "snoozeReminder":
      return { type: "snoozeReminder", targetId: intent.reminderDueIds.join(","), value: true };
  }
}

/**
 * Queues one User-scoped Optimistic Action. Any still-queued row about the
 * same thing (`coalesceKey`) is superseded outright; if that row was also
 * this intent's exact inverse, nothing new is queued either — the pair
 * cancels away, the Sync Backend never hears about either half. Returns the
 * new mutation's id, or `null` on the cancelled-away path.
 */
export async function enqueueUserMutation(intent: UserMutationIntent): Promise<string | null> {
  const db = localCache();
  const key = coalesceKey(intent);

  const id = await db.transaction("rw", db.pendingUserMutations, async () => {
    const sameTarget = (await db.pendingUserMutations.toArray()).filter((mutation) => {
      const candidateKey = coalesceKey(mutation.intent);
      return candidateKey.type === key.type && candidateKey.targetId === key.targetId;
    });
    if (sameTarget.length > 0) {
      await db.pendingUserMutations.bulkDelete(sameTarget.map((mutation) => mutation.id));
    }

    const isInverse = sameTarget.some(
      (mutation) => coalesceKey(mutation.intent).value !== key.value,
    );
    if (isInverse) return null;

    const newId = generateUlid();
    await db.pendingUserMutations.put({ id: newId, createdAt: new Date().toISOString(), intent });
    return newId;
  });

  requestSyncNow();
  return id;
}

/** The whole queue, oldest first (ADR-0010: strict FIFO, same as the per-Mail-Account queue). */
export async function listQueuedUserMutations(): Promise<PendingUserMutation[]> {
  return localCache().pendingUserMutations.orderBy("id").toArray();
}

/**
 * Same shape as `resolveMutationOutcomes` (`mutation-queue.ts`): applied and
 * rejected outcomes both dequeue. Every `UserMutationIntent` variant is an
 * unconditional set (`sync.ts#userMutationIntentSchema`'s own doc comment),
 * so unlike the Thread queue there is no rejection worth a toast over — a
 * `rejected` outcome here would only ever mean this specific User row is
 * gone, not that the edit itself was wrong.
 */
export async function resolveUserMutationOutcomes(outcomes: MutationOutcome[]): Promise<void> {
  for (const outcome of outcomes) {
    await localCache().pendingUserMutations.delete(outcome.id);
  }
}
