import type { ComposeDocument, MailAccount, Recipient } from "@mail/shared";
import { EMPTY_COMPOSE_DOCUMENT } from "@mail/shared";
import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { ChevronDown, ChevronUp, TriangleAlert, X } from "lucide-react";
import type { ClipboardEvent, DragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attachmentUrl } from "../api/attachments.js";
import { clearOpenComposerId, writeOpenComposerId } from "../mail/device-preferences.js";
import {
  type CachedComposition,
  type ComposeContent,
  saveComposition,
  sendComposition,
  subscribeComposeConflicts,
  useComposition,
} from "../store/index.js";
import { requestSyncNow } from "../sync/sync-loop.js";
import { AttachmentsPanel, useAttachments } from "./Attachments.js";
import { ComposeBubbleMenu, ComposeToolbar, insertLink } from "./ComposeToolbar.js";
import { composeEditorExtensions } from "./editor-extensions.js";
import { signatureDocumentNode } from "./mail-signature-extension.js";
import { RecipientField } from "./RecipientField.js";
import { SendControl } from "./SendControl.js";
import { validateSend } from "./send-validation.js";
import "./compose.css";

/** The Client's own local-write debounce (distinct from the backend's ~30s idle push, ADR-0012). */
const AUTOSAVE_DEBOUNCE_MS = 400;

export interface ComposerProps {
  /** Minted once by the caller (`newCompositionId()`) before the composer ever mounts. */
  compositionId: string;
  mailAccounts: MailAccount[];
  defaultMailAccountId: string;
  /**
   * The From resolution chain (#81, mail#66 "From respects Account Scope"):
   * `null` means the account is already settled — a reply/forward (the
   * arriving Message's own account, never a choice) or Account Scope
   * narrowed to exactly one account — and the header renders the static
   * label it always has. A list of two or more Mail Accounts means Scope
   * left it ambiguous for a brand-new compose: `defaultMailAccountId` above
   * is still the User-level default the picker opens on (Scope's primary
   * account), but it renders as a real `<select>` rather than a locked
   * label, so the From address is always the User's own explicit choice
   * rather than a silent guess. `MailSection.tsx`'s `openCompose`/
   * `openReply`/`reopenCompose` are the only three places that decide which
   * of these this composer gets.
   */
  fromChoices: MailAccount[] | null;
  onClose: () => void;
}

/**
 * The docked composer (compose-spec §Composer surface & keys): one at a
 * time, bottom-right, expandable to full screen. `Esc` closes to a Draft —
 * it never discards, so closing is just unmounting after a final, immediate
 * autosave flush (a debounced write mid-flight must not be lost to the
 * unmount race).
 *
 * Send (#46) closes the composer the same way `Esc` does — the Composition
 * lives on as a Pending Send, and its countdown belongs to `PendingSendBar`,
 * which renders outside any composer precisely because the send survives this
 * component (and this device) being gone. The sending-Mail-Account switcher
 * (#81, `fromChoices` below) is now in scope; the explicit Discard button
 * still isn't (#48).
 */
export function Composer({
  compositionId,
  mailAccounts,
  defaultMailAccountId,
  fromChoices,
  onClose,
}: ComposerProps) {
  const existing = useComposition(compositionId);
  const hydratedRef = useRef(false);
  // Real, changeable state now (#81) — not just an initial value: a
  // reopened Composition (a reply/forward's own row, a reopened Draft, a
  // cancelled send) must adopt *its own* `mailAccountId` once it hydrates
  // below, since that can differ from `defaultMailAccountId` (the primary
  // Account Scope account) whenever the row was seeded against some other
  // account — a reply is exactly that case. Explicit From choice (the
  // `fromChoices` picker below) is the other way this ever changes.
  const [mailAccountId, setMailAccountId] = useState(defaultMailAccountId);
  const [subject, setSubject] = useState("");
  const [to, setTo] = useState<Recipient[]>([]);
  const [cc, setCc] = useState<Recipient[]>([]);
  const [bcc, setBcc] = useState<Recipient[]>([]);
  const [showCcBcc, setShowCcBcc] = useState(false);
  // The reply/forward threading headers (#47): held constant across every
  // edit, same as `subject`/`to`/`cc` — hydrated once from an existing
  // Composition, or already seeded on the row a reply/forward's own
  // `saveComposition({force: true})` wrote before this composer ever
  // mounted (`compose/reply.ts#buildReplyContent`, `MailSection.tsx`).
  const [inReplyTo, setInReplyTo] = useState<string | null>(null);
  const [references, setReferences] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  // compose-spec's "warn once, then send" — scoped to this composer, so the
  // warning is about *this* mail and never carried into the next one.
  const [warned, setWarned] = useState(false);

  // The signature (#47, compose-spec §Signature): "inserted into the
  // document when the composer opens ... on new mail, replies and forwards
  // alike." A reply/forward's own row already carries it (its Composition
  // was seeded by `compose/reply.ts#buildReplyContent` before this composer
  // ever mounted) — this is only the brand-new-compose path. A `useState`
  // initializer (not `useMemo`) on purpose: `useEditor`'s own `content`
  // option is read once at mount, never again, so this must genuinely run
  // only once too, not merely skip recomputing while still re-running.
  const [initialDocument] = useState((): ComposeDocument => {
    const signature = mailAccounts.find((account) => account.id === mailAccountId)?.signature;
    if (!signature || signature.trim().length === 0) return EMPTY_COMPOSE_DOCUMENT;
    return { type: "doc", content: [signatureDocumentNode(signature), { type: "paragraph" }] };
  });

  const editor = useEditor({
    extensions: composeEditorExtensions("Write something…"),
    content: initialDocument as JSONContent,
  });

  // Remembers this composer across a reload (device-preferences.ts) — the
  // durable Local Cache row (store/compositions.ts) survives one on its
  // own; this is what points the UI back at it.
  useEffect(() => {
    writeOpenComposerId(compositionId);
  }, [compositionId]);

  /** Shared by the initial hydration below and the "Use theirs" conflict resolution further down — same seven fields, same editor write. `mailAccountId` (#81) is the row's own, not `defaultMailAccountId`: a reply/forward's row was seeded against the Message's arriving account, which may not be Account Scope's primary one. */
  const hydrateFrom = useCallback((row: CachedComposition, targetEditor: Editor) => {
    setMailAccountId(row.mailAccountId);
    setSubject(row.subject);
    setTo(row.to);
    setCc(row.cc);
    setBcc(row.bcc);
    setInReplyTo(row.inReplyTo);
    setReferences(row.references);
    if (row.cc.length > 0 || row.bcc.length > 0) setShowCcBcc(true);
    targetEditor.commands.setContent(row.document as JSONContent, { emitUpdate: false });
  }, []);

  // Reopening an existing Composition (a reload picking `readOpenComposerId`
  // back up) hydrates every field once from its Local Cache row. A brand
  // new composer has no row yet — `existing` simply never resolves to one,
  // and the fields stay at their blank defaults above.
  useEffect(() => {
    if (hydratedRef.current || !existing || !editor) return;
    hydratedRef.current = true;
    hydrateFrom(existing, editor);
  }, [existing, editor, hydrateFrom]);

  // The version-conflict banner (finding #1, ADR-0012/ADR-0014's "the draft
  // changed on another device" state): `resolveComposeSaveOutcomes`
  // (`store/compositions.ts`) already keeps this Client's own edit intact
  // and never auto-retries it — this is only what *shows* the choice.
  // Filtered to this composer's own `compositionId`; "one composer at a
  // time" means that is always the only one open, but a stale listener from
  // an already-closed composer must never fire into this one's state.
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  // Non-null while "Use theirs" is waiting for the next sync round to bring
  // the other device's content down — the value is the row's own
  // `updatedAt` *before* that round, so the effect below can tell "still the
  // stale local copy" apart from "the server's copy just landed" without
  // guessing at timing.
  const [waitingForTheirsSince, setWaitingForTheirsSince] = useState<string | null>(null);

  useEffect(() => {
    return subscribeComposeConflicts((conflict) => {
      if (conflict.compositionId !== compositionId) return;
      setConflictVersion(conflict.version);
    });
  }, [compositionId]);

  useEffect(() => {
    if (waitingForTheirsSince === null || !existing || !editor) return;
    if (existing.updatedAt === waitingForTheirsSince) return; // the sync round hasn't landed yet
    hydrateFrom(existing, editor);
    setWaitingForTheirsSince(null);
  }, [waitingForTheirsSince, existing, editor, hydrateFrom]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentContent = useCallback((): ComposeContent => {
    const document = (editor?.getJSON() ?? EMPTY_COMPOSE_DOCUMENT) as ComposeDocument;
    return { subject, document, to, cc, bcc, inReplyTo, references };
  }, [editor, subject, to, cc, bcc, inReplyTo, references]);

  // #48: "the Composition row is created lazily on first content — a
  // keystroke or attach". An attach that arrives before any keystroke needs
  // the same forced creation the empty-content guard in `saveComposition`
  // otherwise skips.
  const ensureCompositionRow = useCallback(() => {
    void saveComposition(compositionId, mailAccountId, currentContent(), { force: true });
  }, [compositionId, mailAccountId, currentContent]);

  const insertInlineImage = useCallback(
    (meta: { id: string; contentId: string | null; filename: string }) => {
      // `insertContent` takes arbitrary ProseMirror JSON rather than
      // `setImage`'s narrowly-typed `{src, alt, title}` command options, so
      // `ComposeImage`'s own widened attrs (`editor-extensions.ts`:
      // `attachmentId`, `contentId`) need no type gymnastics to reach it.
      editor
        ?.chain()
        .focus()
        .insertContent({
          type: "image",
          attrs: {
            src: attachmentUrl(compositionId, meta.id),
            alt: meta.filename,
            attachmentId: meta.id,
            contentId: meta.contentId,
          },
        })
        .run();
    },
    [editor, compositionId],
  );

  const attachments = existing?.attachments ?? [];
  const {
    uploads,
    budgetError,
    budgetFraction,
    uploading,
    attachFiles,
    removeAttachment,
    retryUpload,
  } = useAttachments(
    compositionId,
    mailAccountId,
    attachments,
    ensureCompositionRow,
    insertInlineImage,
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) attachFiles(files, "attachment");
    },
    [attachFiles],
  );

  // Paste-an-image-into-the-body = inline (compose-spec); anything else in
  // the clipboard's file list falls through to TipTap's own paste handling
  // untouched (plain text, rich HTML, etc).
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      event.preventDefault();
      attachFiles(files, "inline");
    },
    [attachFiles],
  );

  const scheduleAutosave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void saveComposition(compositionId, mailAccountId, currentContent());
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [compositionId, mailAccountId, currentContent]);

  // Every field change reaches the debounce — the editor's own `onUpdate`
  // included, wired below rather than watched here since TipTap does not
  // expose document content as reactive state.
  useEffect(() => {
    scheduleAutosave();
  }, [scheduleAutosave]);

  // A pending debounce must never survive the component it belongs to: an
  // unmount races `flushAndClose`'s own immediate write below, and without
  // this, a leftover timer would eventually fire against whatever Local
  // Cache handle is open *then* — a real hazard across a reopen, not just
  // in tests that reuse a compositionId.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => scheduleAutosave();
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor, scheduleAutosave]);

  // True from the moment a conflict banner appears until the User's choice
  // (or, for "Use theirs", until the server's content has actually landed) —
  // the one window where `currentContent()` is not safe to write, since it
  // may still be the stale copy the conflict was rejected for.
  const hasUnresolvedConflict = conflictVersion !== null || waitingForTheirsSince !== null;

  const verdict = useMemo(() => {
    const base = validateSend({ to, cc, bcc, subject, bodyIsEmpty: editor?.isEmpty ?? true });
    // compose-spec: "send is disabled while an upload is in flight" — a
    // second, independent blocking reason `validateSend` deliberately knows
    // nothing about (its own doc comment: "attachments and their budget are
    // #48's"). A `blocked` verdict from validation itself still wins its own
    // reason, since fixing the recipient is the more useful thing to show.
    if (base.kind !== "blocked" && uploading) {
      return { kind: "blocked" as const, reason: "Uploading…" };
    }
    if (base.kind !== "blocked" && hasUnresolvedConflict) {
      return { kind: "blocked" as const, reason: "Resolve the conflict above before sending" };
    }
    return base;
  }, [to, cc, bcc, subject, editor?.isEmpty, uploading, hasUnresolvedConflict]);

  /**
   * Send: one final content write, one `sendComposition` intent, and the
   * composer closes. `requestSyncNow()` is what makes the Undo window start
   * within a beat rather than on the next 30s poll — the intent is durable
   * either way, this only asks for it to go now.
   *
   * The verdict gate is here rather than in the button so `Cmd/Ctrl+Enter`
   * obeys the same blocking and warn-once rules.
   */
  const send = useCallback(() => {
    if (verdict.kind === "blocked") return;
    if (verdict.kind === "warn" && !warned) {
      setWarned(true);
      return;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void sendComposition(compositionId, mailAccountId, currentContent()).then(requestSyncNow);
    clearOpenComposerId();
    onClose();
  }, [verdict, warned, compositionId, mailAccountId, currentContent, onClose]);

  const flushAndClose = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // The final, un-debounced write: `Esc` never discards, so whatever was
    // typed in the last `AUTOSAVE_DEBOUNCE_MS` must not be lost to the
    // unmount racing the pending timer. Skipped while a conflict is
    // unresolved — `currentContent()` may still be the very copy the
    // conflict was rejected for, and Esc must not become a silent third way
    // to pick a side.
    if (!hasUnresolvedConflict) {
      void saveComposition(compositionId, mailAccountId, currentContent());
    }
    clearOpenComposerId();
    onClose();
  }, [compositionId, mailAccountId, currentContent, onClose, hasUnresolvedConflict]);

  /** "Keep mine" (finding #1): an explicit, User-chosen re-save against the now-corrected version. */
  const keepMine = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void saveComposition(compositionId, mailAccountId, currentContent());
    setConflictVersion(null);
  }, [compositionId, mailAccountId, currentContent]);

  /**
   * "Use theirs" (finding #1): discards nothing directly — there is no
   * server copy to fetch here, since a save outcome carries only the
   * corrected `version` (`store/compositions.ts#ComposeSaveOutcome`). What
   * it does instead is get out of the way: cancel the pending debounce so
   * this Client's stale content is never written again, then ask for a sync
   * round now. `store/server-writes.ts#mergeComposition`'s own merge rule
   * already adopts the wire copy the moment no unflushed edit is queued —
   * true the instant this runs — so the round that comes back is what the
   * effect above (`waitingForTheirsSince`) is watching for.
   */
  const useTheirs = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setConflictVersion(null);
    setWaitingForTheirsSince(existing?.updatedAt ?? null);
    requestSyncNow();
  }, [existing?.updatedAt]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        flushAndClose();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        if (editor) insertLink(editor);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        send();
      }
    }
    // The composer owns every key while it is mounted (compose-spec):
    // capture phase, so it runs before `useTriage`'s own listener, which is
    // additionally suppressed via `shortcutsDisabled` while this is open.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [flushAndClose, editor, send]);

  const fromAddress = useMemo(
    () => mailAccounts.find((account) => account.id === mailAccountId)?.emailAddress ?? "",
    [mailAccounts, mailAccountId],
  );

  if (!editor) return null;

  return (
    <div
      className={`composer${expanded ? " expanded" : ""}`}
      role="dialog"
      aria-label="New message"
      // Drop anywhere on the composer surface = attachment (compose-spec).
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="composer-header">
        {/* #81: several accounts in Scope, no reply context — the User
            chooses explicitly rather than silently sending from whichever
            one happens to be primary. A reply/forward or a single-account
            Scope never reaches this branch (`fromChoices` is `null`), so
            the arriving/settled account keeps its plain, locked label. */}
        {fromChoices && fromChoices.length > 1 ? (
          <select
            className="composer-from composer-from-select"
            aria-label="From"
            value={mailAccountId}
            onChange={(event) => setMailAccountId(event.target.value)}
          >
            {fromChoices.map((account) => (
              <option key={account.id} value={account.id}>
                {account.emailAddress}
              </option>
            ))}
          </select>
        ) : (
          <span className="composer-from" title={fromAddress}>
            {fromAddress}
          </span>
        )}
        <div className="composer-header-actions">
          <button
            type="button"
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button type="button" aria-label="Close" onClick={flushAndClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      {conflictVersion !== null && (
        <div className="composer-conflict-banner" role="alert">
          <TriangleAlert size={14} />
          <span>This draft changed on another device.</span>
          <div className="composer-conflict-actions">
            <button type="button" onClick={keepMine}>
              Keep mine
            </button>
            <button type="button" onClick={useTheirs}>
              Use theirs
            </button>
          </div>
        </div>
      )}

      <div className="composer-recipients">
        <RecipientField label="To" mailAccountId={mailAccountId} recipients={to} onChange={setTo} />
        {!showCcBcc && (
          <button type="button" className="composer-show-ccbcc" onClick={() => setShowCcBcc(true)}>
            Cc/Bcc
          </button>
        )}
        {showCcBcc && (
          <>
            <RecipientField
              label="Cc"
              mailAccountId={mailAccountId}
              recipients={cc}
              onChange={setCc}
            />
            <RecipientField
              label="Bcc"
              mailAccountId={mailAccountId}
              recipients={bcc}
              onChange={setBcc}
            />
          </>
        )}
      </div>

      <input
        type="text"
        className="composer-subject"
        placeholder="Subject"
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
      />

      <ComposeToolbar editor={editor} />
      <ComposeBubbleMenu editor={editor} />
      <div className="composer-body" onPaste={handlePaste}>
        <EditorContent editor={editor} />
      </div>

      <AttachmentsPanel
        compositionId={compositionId}
        attachments={attachments}
        uploads={uploads}
        budgetError={budgetError}
        budgetFraction={budgetFraction}
        onRemove={removeAttachment}
        onRetry={retryUpload}
      />

      <SendControl verdict={verdict} acknowledged={warned} onSend={send} />
    </div>
  );
}
