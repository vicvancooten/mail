import type { MailAccount } from "@mail/shared";
import { useState } from "react";
import { updateMailAccountSignature } from "../api/mail-accounts.js";

/**
 * The per-Mail-Account plain-text signature (#47, compose-spec §Signature) —
 * #54 (Preferences) is where a real settings screen eventually grows this
 * into; this is the minimal inline form that ticket needs an existing value
 * ahead of. Saving is explicit (a button, not on-blur): a signature is the
 * one field where an accidental partial edit going out on the very next
 * email is a genuinely bad failure mode.
 */
export function SignatureEditor({
  account,
  onUpdated,
}: {
  account: MailAccount;
  onUpdated: (account: MailAccount) => void;
}) {
  const [value, setValue] = useState(account.signature ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const signature = value.trim().length > 0 ? value : null;
      const result = await updateMailAccountSignature(account.id, { signature });
      onUpdated(result.mailAccount);
    } catch {
      setError("Couldn't save the signature.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="signature-editor">
      <label htmlFor={`signature-${account.id}`}>Signature</label>
      <textarea
        id={`signature-${account.id}`}
        rows={3}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="No signature set"
      />
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save signature"}
      </button>
    </div>
  );
}
