import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { type FormEvent, useState } from "react";
import { ApiError } from "../api/auth.js";
import { useAuth } from "./AuthContext.js";

/**
 * Shown both for a fresh login and after a session expires — poc-spec.md is
 * explicit that expiry degrades to this prompt rather than wiping whatever
 * else the Client was showing, so this form has no opinion on why it's on
 * screen. Also offers passkey login (#32) as an alternate primary — when
 * the platform doesn't support WebAuthn, the button doesn't render at all
 * rather than offering something bound to fail.
 */
export function LoginForm() {
  const { login, loginWithPasskey } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ username, password });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid_credentials"
          ? "Incorrect username or password."
          : "Couldn't reach the server.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePasskeyLogin() {
    setError(null);
    setSubmitting(true);
    try {
      await loginWithPasskey();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid_credentials"
          ? "That passkey isn't registered here."
          : "Couldn't complete passkey sign-in.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2>Log in</h2>
      <div>
        <label htmlFor="login-username">Username</label>
        <input
          id="login-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        Log in
      </button>
      {browserSupportsWebAuthn() && (
        <button type="button" onClick={handlePasskeyLogin} disabled={submitting}>
          Log in with a passkey
        </button>
      )}
    </form>
  );
}
