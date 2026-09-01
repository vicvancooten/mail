import type { ComposeDocument, MailAccount, Recipient } from "@mail/shared";
import { EMPTY_COMPOSE_DOCUMENT } from "@mail/shared";
import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearOpenComposerId, writeOpenComposerId } from "../mail/device-preferences.js";
import { type ComposeContent, saveComposition, useComposition } from "../store/index.js";
import { ComposeBubbleMenu, ComposeToolbar, insertLink } from "./ComposeToolbar.js";
import { composeEditorExtensions } from "./editor-extensions.js";
import { RecipientField } from "./RecipientField.js";
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
 * unmount race). Discard, the sending-Mail-Account switcher, and Send
 * itself are out of this ticket's scope (compose-spec's Discard button
 * needs #46's Pending Send lifecycle; Send needs #46's SMTP submission) —
 * `Cmd/Ctrl+Enter` is wired but a no-op until #46 lands.
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
  const [expanded, setExpanded] = useState(false);

  const editor = useEditor({
    extensions: composeEditorExtensions("Write something…"),
    content: EMPTY_COMPOSE_DOCUMENT as JSONContent,
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
    if (existing.cc.length > 0 || existing.bcc.length > 0) setShowCcBcc(true);
    editor.commands.setContent(existing.document as JSONContent, { emitUpdate: false });
  }, [existing, editor]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentContent = useCallback((): ComposeContent => {
    const document = (editor?.getJSON() ?? EMPTY_COMPOSE_DOCUMENT) as ComposeDocument;
    return { subject, document, to, cc, bcc };
  }, [editor, subject, to, cc, bcc]);

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
        // Send is #46's (Pending Send, Undo Send, SMTP submission) — wired
        // here so the binding exists and does nothing destructive yet.
        event.preventDefault();
      }
    }
    // The composer owns every key while it is mounted (compose-spec):
    // capture phase, so it runs before `useTriage`'s own listener, which is
    // additionally suppressed via `shortcutsDisabled` while this is open.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [flushAndClose, editor]);

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
      <div className="composer-body">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
