import type { Passkey } from "@mail/shared";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useCallback, useEffect, useState } from "react";
import { deletePasskey, fetchPasskeys, registerPasskey } from "../api/passkeys.js";

/**
 * Passkey register + list + remove (#32), the minimal management surface
 * the ticket asks for — a full settings screen is the Preferences ticket.
 */
export function PasskeysSection() {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(() => {
    return fetchPasskeys()
      .then(setPasskeys)
      .catch(() => setError("Couldn't load passkeys."));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleRegister() {
    setError(null);
    setSubmitting(true);
    try {
      await registerPasskey();
      await reload();
    } catch {
      setError("Couldn't register a passkey on this device.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove(id: string) {
    setError(null);
    setSubmitting(true);
    try {
      await deletePasskey(id);
      await reload();
    } catch {
      setError("Couldn't remove that passkey.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h3>Passkeys</h3>
      {error && <p role="alert">{error}</p>}

      {passkeys === null && <p>Loading…</p>}

      {passkeys !== null && passkeys.length === 0 && <p>No passkeys registered yet.</p>}

      {passkeys !== null && passkeys.length > 0 && (
        <ul>
          {passkeys.map((passkey) => (
            <li key={passkey.id}>
              Added {new Date(passkey.createdAt).toLocaleDateString()}
              {passkey.lastUsedAt &&
                ` · last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`}{" "}
              <button type="button" onClick={() => handleRemove(passkey.id)} disabled={submitting}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {browserSupportsWebAuthn() && (
        <button type="button" onClick={handleRegister} disabled={submitting}>
          Add a passkey
        </button>
      )}
    </section>
  );
}
