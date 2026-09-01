import type { Recipient } from "@mail/shared";
import { useState } from "react";
import { isSyntacticallyValidAddress, parseRecipients, recipientLabel } from "./recipients.js";

/**
 * A `To`/`Cc`/`Bcc` chip field (compose-spec §Recipients). Typing a
 * separator (comma, semicolon, Enter) or pasting a block of addresses both
 * go through the same `parseRecipients` split — a paste is just several
 * separators arriving at once. Recipient autocomplete (#49) is a later
 * ticket; this is plain text entry with syntactic-only validation, flagging
 * a chip that does not look like an address rather than refusing it —
 * compose-spec's blocking rule ("no syntactically valid recipient") is
 * send-time's to enforce, not this field's.
 */
export function RecipientField({
  label,
  recipients,
  onChange,
}: {
  label: string;
  recipients: Recipient[];
  onChange: (next: Recipient[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function commitDraft() {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    onChange([...recipients, ...parseRecipients(trimmed)]);
    setDraft("");
  }

  function removeAt(index: number) {
    onChange(recipients.filter((_, i) => i !== index));
  }

  return (
    <div className="recipient-field">
      <span className="recipient-field-label" id={`recipient-${label}`}>
        {label}
      </span>
      <ul className="recipient-chips" aria-labelledby={`recipient-${label}`}>
        {recipients.map((recipient, index) => (
          // The address, not the index: two chips can genuinely share one
          // (a not-yet-corrected typo re-added), and only the address
          // survives a reorder — the list itself is append/remove-only, so
          // this never needs to disambiguate a true duplicate pair.
          <li
            key={recipient.address}
            className={`recipient-chip${isSyntacticallyValidAddress(recipient.address) ? "" : " invalid"}`}
          >
            {recipientLabel(recipient)}
            <button
              type="button"
              aria-label={`Remove ${recipientLabel(recipient)}`}
              onClick={() => removeAt(index)}
            >
              ×
            </button>
          </li>
        ))}
        <li className="recipient-input">
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text");
              if (/[,;\n]/.test(text)) {
                event.preventDefault();
                onChange([...recipients, ...parseRecipients(text)]);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "," || event.key === ";") {
                event.preventDefault();
                commitDraft();
                return;
              }
              if (event.key === "Backspace" && draft.length === 0 && recipients.length > 0) {
                removeAt(recipients.length - 1);
              }
            }}
            onBlur={commitDraft}
            aria-label={`${label} recipients`}
          />
        </li>
      </ul>
    </div>
  );
}
