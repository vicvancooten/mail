import { type FormEvent, useState } from "react";
import { ApiError } from "../api/auth.js";
import { useAuth } from "./AuthContext.js";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_or_expired_token: "That claim link has expired or was already used.",
  username_taken: "That username is already taken.",
};

/**
 * First-run: claims the Owner with the one-time token printed to the
 * backend's logs (ADR-0009 deployment). Pre-fills the token from
 * `?token=` when the operator followed the logged link.
 */
export function ClaimForm() {
  const { claim } = useAuth();
  const [token, setToken] = useState(
    () => new URLSearchParams(window.location.search).get("token") ?? "",
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await claim({ token, username, password });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (ERROR_MESSAGES[err.code] ??
              "Couldn't claim this instance. Check the details and try again.")
          : "Couldn't reach the server.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2>Claim this instance</h2>
      <p>Set up the Owner account using the one-time token printed in the server logs.</p>
      <div>
        <label htmlFor="claim-token">Claim token</label>
        <input
          id="claim-token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="claim-username">Username</label>
        <input
          id="claim-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="claim-password">Password</label>
        <input
          id="claim-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        Create Owner account
      </button>
    </form>
  );
}
