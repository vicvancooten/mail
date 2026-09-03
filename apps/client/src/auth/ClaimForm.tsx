import { type FormEvent, useState } from "react";
import { ApiError } from "../api/auth.js";
import { Button } from "../components/ui/button.js";
import { useAuth } from "./AuthContext.js";
import { Field, FormError, inputClassName } from "./form-controls.js";

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
    <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
      <h2 className="m-0 text-base font-bold text-foreground">Claim this instance</h2>
      <p className="m-0 max-w-[46ch] text-[13px] text-muted-foreground">
        Set up the Owner account using the one-time token printed in the server logs.
      </p>
      <Field label="Claim token" htmlFor="claim-token">
        <input
          id="claim-token"
          className={inputClassName}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
        />
      </Field>
      <Field label="Username" htmlFor="claim-username">
        <input
          id="claim-username"
          className={inputClassName}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </Field>
      <Field label="Password" htmlFor="claim-password">
        <input
          id="claim-password"
          type="password"
          className={inputClassName}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </Field>
      {error && <FormError>{error}</FormError>}
      <Button type="submit" disabled={submitting} className="w-full">
        Create Owner account
      </Button>
    </form>
  );
}
