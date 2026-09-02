import type { MailAccount } from "@mail/shared";
import { useState } from "react";
import { enqueueMutation } from "../store/index.js";

/**
 * The per-Mail-Account plain-text signature (#47, compose-spec §Signature;
 * #54, poc-spec.md §Preferences): the Mail-Account-scoped half of
 * Preferences, alongside the notification toggle. Saved through the ordinary
 * Optimistic Action queue (`setSignature`) rather than a dedicated route, so
 * an edit made offline is durable and shows immediately via
 * `readMailAccounts()`'s overlay — the same "edits are optimistic and
 * survive offline" bar every other Preference meets. Saving is still
 * explicit (a button, not on-blur): a signature is the one field where an
 * accidental partial edit going out on the very next email is a genuinely
 * bad failure mode.
 */
export function SignatureEditor({ account }: { account: MailAccount }) {
  const [value, setValue] = useState(account.signature ?? "");
  const [saved, setSaved] = useState(false);

  const save = () => {
    const signature = value.trim().length > 0 ? value : null;
    void enqueueMutation({ type: "setSignature", signature }, account.id);
    setSaved(true);
  };

  return (
    <div className="signature-editor">
      <label htmlFor={`signature-${account.id}`}>Signature</label>
      <textarea
        id={`signature-${account.id}`}
        rows={3}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setSaved(false);
        }}
        placeholder="No signature set"
      />
      <button type="button" onClick={save}>
        Save signature
      </button>
      {saved && <p role="status">Saved.</p>}
    </div>
  );
}
