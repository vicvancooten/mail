import type {
  AttachmentMeta,
  ComposeDocument,
  ComposeNode,
  ComposeSave,
  ComposeSaveOutcome,
  MutationIntent,
  Recipient,
} from "@mail/shared";
import { EMPTY_COMPOSE_DOCUMENT } from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import type { CachedComposition, PendingComposeSave } from "./db.js";
import { localCache } from "./local-cache.js";
import { enqueueMutation } from "./mutation-queue.js";
import { generateUlid } from "./ulid.js";

/**
 * A Composition's Local Cache row and its coalescing autosave queue
 * (ADR-0014, #45) — component-facing read and write together, `sync/`-facing
 * flush together, the same "one focused concern, one module" shape
 * `cache-pins.ts` uses (see `db.ts#CachedComposition`'s doc comment for why
 * this does not split along `reads.ts`/`mutation-queue.ts`'s line).
 */

export interface ComposeContent {
  subject: string;
  document: ComposeDocument;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  /** The reply/forward threading headers (#47, `compose/reply.ts`) — `null`/`[]` for an ordinary new compose. */
  inReplyTo: string | null;
  references: string[];
}

export const EMPTY_COMPOSE_CONTENT: ComposeContent = {
  subject: "",
  document: EMPTY_COMPOSE_DOCUMENT,
  to: [],
  cc: [],
  bcc: [],
  inReplyTo: null,
  references: [],
};

/** A fresh Composition id, mintable before any content exists — the composer opens with one immediately. */
export function newCompositionId(): string {
  return generateUlid();
}

export function useComposition(id: string | null): CachedComposition | undefined {
  return useLiveQuery(() => readComposition(id), [id]);
}

async function readComposition(id: string | null): Promise<CachedComposition | undefined> {
  if (id === null) return undefined;
  return localCache().compositions.get(id);
}

/**
 * The Drafts sidebar view (#74, #101): every Composition still in
 * `status: "draft"` — ADR-0012's "one status that means editable" is exactly
 * what this view lists, newest-first. Deliberately excludes the in-flight
 * statuses (`pending`/`submitting`): a Pending Send is no longer a Draft,
 * it's on its way out (`PendingSendBar` is where that renders), and
 * `sent`/`failed`/`discarded` are settled either way.
 *
 * `mailAccountId` is Account Scope (#73, #101) the same way
 * `reads.ts#useThreadWindow`'s own doc comment describes: an array merges
 * every named account's Drafts into one newest-first list, so the Drafts
 * view spans the current Scope rather than only the primary account. The
 * dependency list keys off the joined ids, matching `useThreadWindow`'s own
 * reasoning for why.
 */
export function useDraftCompositions(
  mailAccountId: string | readonly string[] | null,
): CachedComposition[] | undefined {
  const ids: readonly string[] =
    mailAccountId === null ? [] : Array.isArray(mailAccountId) ? mailAccountId : [mailAccountId];
  const key = ids.join(",");
  return useLiveQuery(() => readDraftCompositions(ids), [key]);
}

export async function readDraftCompositions(
  mailAccountIds: readonly string[],
): Promise<CachedComposition[]> {
  if (mailAccountIds.length === 0) return [];
  const rows = await localCache()
    .compositions.where("mailAccountId")
    .anyOf(mailAccountIds)
    .filter((row) => row.status === "draft")
    .toArray();
  return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Writes one autosave. The Composition row is created lazily right here, on
 * whatever the first call happens to be (ADR-0012: "created lazily on first
 * content") — there is no separate `createComposition`. Both the durable
 * content row and the coalescing queue row are written in one transaction,
 * so a reload between them can never observe one without the other.
 *
 * Coalescing is `pendingComposeSaves.put()`'s own upsert semantics: a second
 * call for the same `id` before the first has flushed simply overwrites the
 * queued row — ADR-0014's "the single deliberate exception to the FIFO,
 * additive intent queue," bought here with no cancellation logic, unlike
 * `mutation-queue.ts`'s inverse-cancels-out case.
 */
export async function saveComposition(
  id: string,
  mailAccountId: string,
  content: ComposeContent,
  options: { force?: boolean } = {},
): Promise<void> {
  const db = localCache();
  const now = new Date().toISOString();
  await db.transaction("rw", [db.compositions, db.pendingComposeSaves], async () => {
    const existing = await db.compositions.get(id);
    // ADR-0012: "created lazily on first content." A composer opened and
    // closed without a keystroke must leave nothing behind — an *existing*
    // row is still written through even if the User deletes everything back
    // to blank, since that is an ordinary edit, not a creation. `force`
    // (compose-spec: "the Composition row is created lazily on first
    // content — keystroke or attach") is `store/attachments.ts`'s own way of
    // taking the same "first content" branch for an attach with no keystroke
    // behind it yet.
    if (!existing && !options.force && isComposeContentEmpty(content)) return;
    const row: CachedComposition = {
      id,
      mailAccountId,
      // Every server-owned field is carried through untouched: autosave is
      // about content, and predicting a send state here would be exactly the
      // locally-invented countdown ADR-0014 rules out.
      status: existing?.status ?? "draft",
      submitAfter: existing?.submitAfter ?? null,
      sendError: existing?.sendError ?? null,
      sentAt: existing?.sentAt ?? null,
      sendState: existing?.sendState ?? null,
      attachments: existing?.attachments ?? [],
      ...content,
      version: existing?.version ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await db.compositions.put(row);
    await enqueueSave(db, id, mailAccountId, content, now);
  });
}

async function enqueueSave(
  db: ReturnType<typeof localCache>,
  compositionId: string,
  mailAccountId: string,
  content: ComposeContent,
  queuedAt: string,
): Promise<void> {
  const save: PendingComposeSave = {
    compositionId,
    mailAccountId,
    saveId: generateUlid(),
    ...content,
    queuedAt,
  };
  await db.pendingComposeSaves.put(save);
}

/** This Mail Account's queued autosaves — at most one per Composition, order otherwise unpromised. */
export async function listQueuedComposeSaves(mailAccountId: string): Promise<PendingComposeSave[]> {
  return localCache().pendingComposeSaves.where("mailAccountId").equals(mailAccountId).toArray();
}

/**
 * Builds the wire `ComposeSave` for one queued row: `version` is read fresh
 * from the Composition's *current* local row rather than carried on the
 * queue row itself (`db.ts#PendingComposeSave`'s doc comment) — the fix for
 * the race where an in-flight save's response bumps the version while a
 * newer, already-coalesced save is still waiting to go out.
 */
export async function toWireComposeSave(pending: PendingComposeSave): Promise<ComposeSave> {
  const composition = await localCache().compositions.get(pending.compositionId);
  return {
    id: pending.compositionId,
    saveId: pending.saveId,
    version: composition?.version ?? 0,
    subject: pending.subject,
    document: pending.document,
    to: pending.to,
    cc: pending.cc,
    bcc: pending.bcc,
    inReplyTo: pending.inReplyTo,
    references: pending.references,
  };
}

/**
 * Resolves outcomes for a round's flushed saves. `applied`/`conflict` both
 * carry the server's authoritative `version`, which is recorded either way —
 * a `conflict` is never silently discarded, it is an accepted fact about
 * where the server now stands. A queued row is only dequeued when its own
 * `saveId` still matches the outcome's: a newer, already-coalesced save
 * overwrote it mid-flight, and *that* save is what gets sent next, never
 * this stale outcome's.
 *
 * A `conflict` does **not** re-queue the stale content it was rejected
 * against: ADR-0012's "Silently overwriting typed text is the one failure
 * worth code to prevent" ruled out an automatic retry, since a retry against
 * the now-corrected version is *guaranteed* to succeed and would silently
 * clobber whatever the other device wrote — the exact failure that line
 * names. Instead this notifies `subscribeComposeConflicts` below with the
 * corrected version, so the composer can show it and let the User choose:
 * "Keep mine" is an explicit, User-initiated `saveComposition` against the
 * now-correct version (ADR-0014's real "the draft changed on another
 * device" state), and "Use theirs" leaves nothing queued, which is what lets
 * the very next ordinary sync round's `applyCompositionDelta`
 * (`server-writes.ts`) adopt the server's content — its own merge rule
 * already takes the wire copy whenever no unflushed edit is queued.
 */
export async function resolveComposeSaveOutcomes(
  mailAccountId: string,
  queued: ComposeSave[],
  outcomes: ComposeSaveOutcome[],
): Promise<void> {
  const db = localCache();
  const byId = new Map(queued.map((save) => [save.id, save]));

  for (const outcome of outcomes) {
    await db.transaction("rw", [db.compositions, db.pendingComposeSaves], async () => {
      if (outcome.status !== "rejected") {
        const composition = await db.compositions.get(outcome.id);
        if (composition) await db.compositions.put({ ...composition, version: outcome.version });
      }

      const stillQueued = await db.pendingComposeSaves.get(outcome.id);
      if (!stillQueued || stillQueued.saveId !== outcome.saveId) return; // superseded mid-flight; leave it queued
      await db.pendingComposeSaves.delete(outcome.id);
    });

    if (outcome.status === "conflict") {
      const save = byId.get(outcome.id);
      if (save) {
        notifyConflict({ mailAccountId, compositionId: outcome.id, version: outcome.version });
      }
    }
  }
}

/**
 * Writes one just-uploaded attachment's metadata into the Composition's row
 * directly (#48) — an optimistic mirror of what `putBlob` already committed
 * server-side, so the row the composer just attached to shows up
 * immediately rather than waiting for the next sync round to confirm it.
 * `server-writes.ts#mergeComposition` later overwrites `attachments`
 * wholesale from the wire anyway, so this can never drift permanently even
 * if the optimistic write and the delta briefly disagree.
 */
export async function recordAttachmentUploaded(
  compositionId: string,
  meta: AttachmentMeta,
): Promise<void> {
  const db = localCache();
  const row = await db.compositions.get(compositionId);
  if (!row) return;
  await db.compositions.put({ ...row, attachments: [...row.attachments, meta] });
}

/** The mirror of `recordAttachmentUploaded`, for a Remove button's own optimistic update. */
export async function recordAttachmentRemoved(
  compositionId: string,
  attachmentId: string,
): Promise<void> {
  const db = localCache();
  const row = await db.compositions.get(compositionId);
  if (!row) return;
  await db.compositions.put({
    ...row,
    attachments: row.attachments.filter((entry) => entry.id !== attachmentId),
  });
}

/** Whether a save carries nothing worth creating a Composition for (ADR-0012: "created lazily on first content"). */
export function isComposeContentEmpty(content: ComposeContent): boolean {
  if (content.subject.trim().length > 0) return false;
  if (content.to.length > 0 || content.cc.length > 0 || content.bcc.length > 0) return false;
  return content.document.content.every(isNodeEmpty);
}

function isNodeEmpty(node: ComposeNode): boolean {
  if (node.type === "text") return (node.text ?? "").trim().length === 0;
  // A node with no text but a meaning of its own — an image, a divider —
  // is content the empty-document check must not swallow.
  if (node.content === undefined) return node.type === "paragraph";
  return node.content.every(isNodeEmpty);
}

export interface ComposeSaveConflict {
  mailAccountId: string;
  compositionId: string;
  /** The server's corrected version, already written to the local Composition row by the time this fires. */
  version: number;
}

const conflictListeners = new Set<(conflict: ComposeSaveConflict) => void>();

/**
 * ADR-0014's "the draft changed on another device" state: `Composer.tsx`
 * subscribes to show its "Keep mine / Use theirs" banner. `saveComposition`
 * — called with the composer's live content when the User picks "Keep
 * mine" — is the ordinary write path, nothing conflict-specific about it;
 * this seam exists only to *raise* the conflict, not to resolve it.
 */
export function subscribeComposeConflicts(
  listener: (conflict: ComposeSaveConflict) => void,
): () => void {
  conflictListeners.add(listener);
  return () => conflictListeners.delete(listener);
}

function notifyConflict(conflict: ComposeSaveConflict): void {
  for (const listener of conflictListeners) listener(conflict);
}

/**
 * Presses Send (#46, ADR-0007/ADR-0014). Three things, in this order and for
 * this reason:
 *
 * 1. **A final, un-debounced autosave.** Send means "send what I am looking
 *    at", and the backend submits whatever the Composition row holds. The
 *    save and the intent go out in the same `POST /sync` round, where the
 *    route drains saves before mutations (`routes/sync.ts`).
 * 2. **A `sendComposition` intent on the durable queue.** Offline this simply
 *    waits, which is ADR-0014's "an offline send queues, and says so".
 * 3. **`sendState: "queued"`,** the only thing this Client asserts about the
 *    send. It never invents a `submitAfter`: the countdown starts when the
 *    Sync Backend accepts the send and reports the absolute instant it chose
 *    (ADR-0007 measures the delay from server receipt), so until then the UI
 *    says "sending" rather than counting down from a number it made up.
 */
export async function sendComposition(
  id: string,
  mailAccountId: string,
  content: ComposeContent,
): Promise<void> {
  await saveComposition(id, mailAccountId, content);
  await enqueueMutation({ type: "sendComposition", compositionId: id }, mailAccountId);
  await setSendState(id, "queued");
}

/**
 * Undo Send. Optimistic only in the weak sense — `cancelling` is a "this is
 * in flight" marker, not a predicted outcome — because the cancel genuinely
 * may lose: ADR-0007's claim is atomic and a late cancel "is reported to the
 * User as too late". `resolveSendOutcomes` below is where that verdict
 * lands.
 */
export async function requestCancelSend(id: string, mailAccountId: string): Promise<void> {
  const queued = await enqueueMutation({ type: "cancelSend", compositionId: id }, mailAccountId);
  // `null` means the cancel coalesced the still-queued send away
  // (`mutation-queue.ts`): the Sync Backend never heard about this send, so
  // there is nothing in flight to mark and the Composition is already back to
  // being an ordinary Draft.
  await setSendState(id, queued === null ? null : "cancelling");
}

async function setSendState(id: string, sendState: CachedComposition["sendState"]): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.compositions, async () => {
    const row = await db.compositions.get(id);
    if (row) await db.compositions.put({ ...row, sendState });
  });
}

async function setCompositionStatus(
  id: string,
  status: CachedComposition["status"],
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.compositions, async () => {
    const row = await db.compositions.get(id);
    if (row) await db.compositions.put({ ...row, status });
  });
}

/**
 * Delete (#101, ADR-0012's "deletion is asymmetric"). Optimistic the same
 * way `useTriage.ts`'s `archive`/`trash` are: the row's `status` flips to
 * `discarded` — which is the whole of what `useDraftCompositions` filters
 * on — the instant this is called, not once the Sync Backend answers.
 * `enqueueMutation`'s own coalescer (`mutation-queue.ts`'s "discard" bucket)
 * cancels a still-queued `undiscardComposition` for free (ADR-0019), same
 * as `sendComposition`/`cancelSend`'s "send" bucket.
 *
 * Callers own raising the Undo toast (`Composer.tsx`, mirroring
 * `screener/Screener.tsx`'s own "the component wires the toast, the store
 * stays store" posture) — this function only enqueues and flips the row.
 */
export async function discardComposition(id: string, mailAccountId: string): Promise<void> {
  await enqueueMutation({ type: "discardComposition", compositionId: id }, mailAccountId);
  await setCompositionStatus(id, "discarded");
}

/** Undo's real inverse (#95, ADR-0019) — see `discardComposition` above. */
export async function undiscardComposition(id: string, mailAccountId: string): Promise<void> {
  await enqueueMutation({ type: "undiscardComposition", compositionId: id }, mailAccountId);
  await setCompositionStatus(id, "draft");
}

/**
 * Turns a rejected `discardComposition`/`undiscardComposition` outcome back
 * into the local `status` (`sync/sync-round.ts` calls this beside
 * `resolveSendOutcomes`, same per-round pairing). An `applied` outcome needs
 * nothing here — the same round trip already carries the confirming
 * `Composition` delta, which is what "lets the server's synced status speak"
 * means for `resolveSendOutcomes` too. A rejection (the row was no longer a
 * Draft — sent, or already discarded elsewhere — by the time this reached
 * the server) reverts the optimistic flip this file made above, rather than
 * leaving a Draft stuck showing the wrong status until the next full sync.
 */
export async function resolveDiscardOutcomes(
  outcomes: { intent: MutationIntent; status: "applied" | "rejected"; reason?: string }[],
): Promise<void> {
  for (const outcome of outcomes) {
    const intent = outcome.intent;
    if (intent.type !== "discardComposition" && intent.type !== "undiscardComposition") continue;
    if (outcome.status === "applied") continue;
    await setCompositionStatus(
      intent.compositionId,
      intent.type === "discardComposition" ? "draft" : "discarded",
    );
  }
}

/**
 * Turns the two Composition intents' outcomes into the local `sendState`
 * (`sync/sync-round.ts` calls this beside `resolveMutationOutcomes`).
 *
 * An `applied` outcome clears the marker and lets the server's synced
 * `status` speak — which it can, because that same round trip carried the
 * `Composition` delta. A rejected `cancelSend` is the one outcome the User
 * is shown: `too_late` sticks on the row until the composer is next opened,
 * so "your Undo lost the race, the mail is on its way" is a fact on the
 * screen rather than a toast that may already have vanished.
 */
export async function resolveSendOutcomes(
  outcomes: { intent: MutationIntent; status: "applied" | "rejected"; reason?: string }[],
): Promise<void> {
  for (const outcome of outcomes) {
    const intent = outcome.intent;
    if (intent.type !== "sendComposition" && intent.type !== "cancelSend") continue;
    if (outcome.status === "applied") {
      await setSendState(intent.compositionId, null);
      continue;
    }
    await setSendState(
      intent.compositionId,
      intent.type === "cancelSend" && outcome.reason === "too_late" ? "too_late" : null,
    );
  }
}

/**
 * Every Composition of one Mail Account with a live send — server-side
 * `pending`/`submitting`, or a send this Client has queued and not yet had
 * answered. This is what the Undo Send bar renders, and it is deliberately
 * *not* scoped to the open composer: a Pending Send started on another
 * device shows up here too, which is the whole point of the backend holding
 * it (ADR-0007).
 */
export function usePendingSends(mailAccountId: string | null): CachedComposition[] | undefined {
  return useLiveQuery(() => readPendingSends(mailAccountId), [mailAccountId]);
}

async function readPendingSends(mailAccountId: string | null): Promise<CachedComposition[]> {
  if (mailAccountId === null) return [];
  const rows = await localCache()
    .compositions.where("mailAccountId")
    .equals(mailAccountId)
    .toArray();
  return rows
    .filter(
      (row) =>
        row.status === "pending" ||
        row.status === "submitting" ||
        row.sendState === "queued" ||
        row.sendState === "cancelling" ||
        // A cancel that lost the race (ADR-0007) stays on the bar until the
        // send resolves, so "too late" is something the User reads rather
        // than a toast that may already have gone.
        row.sendState === "too_late",
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Drafts carrying a permanent SMTP rejection — compose-spec's "persistent
 * in-app banner until resolved". Sending again clears `sendError` server-side
 * (`compose/pending-send.ts#acceptSend`), which is what "resolved" means.
 */
export function useFailedSends(mailAccountId: string | null): CachedComposition[] | undefined {
  return useLiveQuery(() => readFailedSends(mailAccountId), [mailAccountId]);
}

async function readFailedSends(mailAccountId: string | null): Promise<CachedComposition[]> {
  if (mailAccountId === null) return [];
  const rows = await localCache()
    .compositions.where("mailAccountId")
    .equals(mailAccountId)
    .toArray();
  return rows
    .filter((row) => row.sendError !== null && row.status === "draft")
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Seconds left on a Pending Send's countdown, or `null` when there is no
 * server-issued deadline to count from yet (an offline or in-flight send).
 * The deadline is the server's absolute `submitAfter` and the tick is local,
 * so a clock skewed by a few seconds shortens or lengthens the *displayed*
 * window without ever changing when the mail actually goes out.
 */
export function undoSecondsRemaining(
  row: CachedComposition,
  now: number = Date.now(),
): number | null {
  if (row.submitAfter === null) return null;
  const remaining = Date.parse(row.submitAfter) - now;
  if (Number.isNaN(remaining)) return null;
  return Math.max(0, Math.ceil(remaining / 1000));
}
