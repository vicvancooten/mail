import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { type FormEvent, useState } from "react";
import { ApiError } from "../api/auth.js";
import { Button } from "../components/ui/button.js";
import { useAuth } from "./AuthContext.js";
import { Field, FormError, inputClassName } from "./form-controls.js";

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
    <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
      <h2 className="m-0 text-base font-bold text-foreground">Log in</h2>
      <Field label="Username" htmlFor="login-username">
        <input
          id="login-username"
          className={inputClassName}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </Field>
      <Field label="Password" htmlFor="login-password">
        <input
          id="login-password"
          type="password"
          className={inputClassName}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </Field>
      {error && <FormError>{error}</FormError>}
      <Button type="submit" disabled={submitting} className="w-full">
        Log in
      </Button>
      {browserSupportsWebAuthn() && (
        <Button
          type="button"
          variant="outline"
          onClick={handlePasskeyLogin}
          disabled={submitting}
          className="w-full"
        >
          Log in with a passkey
        </Button>
      )}
    </form>
  );
}
