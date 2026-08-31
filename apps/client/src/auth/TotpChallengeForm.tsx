import { type FormEvent, useState } from "react";
import { ApiError } from "../api/auth.js";
import { useAuth } from "./AuthContext.js";

/**
 * The second half of a TOTP-gated login (#32): shown once a `PrimaryAuthMethod`
 * (password or passkey) has already succeeded, per `AuthState.totp-required`.
 */
export function TotpChallengeForm() {
  const { completeTotpLogin, cancelTotpLogin } = useAuth();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await completeTotpLogin(code);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid_code"
          ? "That code isn't right — check the current one in your authenticator app."
          : "Couldn't reach the server.",
      );
      setCode("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2>Enter your authenticator code</h2>
      <div>
        <label htmlFor="totp-code">6-digit code</label>
        <input
          id="totp-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
        />
      </div>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        Verify
      </button>
      <button type="button" onClick={cancelTotpLogin} disabled={submitting}>
        Back
      </button>
    </form>
  );
}
