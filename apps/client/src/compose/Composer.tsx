import type { ComposeDocument, MailAccount, Recipient } from "@mail/shared";
import { EMPTY_COMPOSE_DOCUMENT } from "@mail/shared";
import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { Maximize2, Minimize2, X } from "lucide-react";
import type { ClipboardEvent, DragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attachmentUrl } from "../api/attachments.js";
import { clearOpenComposerId, writeOpenComposerId } from "../mail/device-preferences.js";
import {
  type ComposeContent,
  saveComposition,
  sendComposition,
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
 * and the explicit Discard button are still out of scope (#47, #48).
 */
export function Composer({
  compositionId,
  mailAccounts,
  defaultMailAccountId,
  onClose,
}: ComposerProps) {
  const existing = useComposition(compositionId);
  const hydratedRef = useRef(false);
  const [mailAccountId] = useState(defaultMailAccountId);
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

  // Reopening an existing Composition (a reload picking `readOpenComposerId`
  // back up) hydrates every field once from its Local Cache row. A brand
  // new composer has no row yet — `existing` simply never resolves to one,
  // and the fields stay at their blank defaults above.
  useEffect(() => {
    if (hydratedRef.current || !existing || !editor) return;
    hydratedRef.current = true;
    setSubject(existing.subject);
    setTo(existing.to);
    setCc(existing.cc);
    setBcc(existing.bcc);
    setInReplyTo(existing.inReplyTo);
    setReferences(existing.references);
    if (existing.cc.length > 0 || existing.bcc.length > 0) setShowCcBcc(true);
    editor.commands.setContent(existing.document as JSONContent, { emitUpdate: false });
  }, [existing, editor]);

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
    return base;
  }, [to, cc, bcc, subject, editor?.isEmpty, uploading]);

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
    // unmount racing the pending timer.
    void saveComposition(compositionId, mailAccountId, currentContent());
    clearOpenComposerId();
    onClose();
  }, [compositionId, mailAccountId, currentContent, onClose]);

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
        <span className="composer-from" title={fromAddress}>
          {fromAddress}
        </span>
        <div className="composer-header-actions">
          <button
            type="button"
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button type="button" aria-label="Close" onClick={flushAndClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="composer-recipients">
        <RecipientField label="To" recipients={to} onChange={setTo} />
        {!showCcBcc && (
          <button type="button" className="composer-show-ccbcc" onClick={() => setShowCcBcc(true)}>
            Cc/Bcc
          </button>
        )}
        {showCcBcc && (
          <>
            <RecipientField label="Cc" recipients={cc} onChange={setCc} />
            <RecipientField label="Bcc" recipients={bcc} onChange={setBcc} />
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
