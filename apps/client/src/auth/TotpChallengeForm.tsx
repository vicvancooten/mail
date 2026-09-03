import { type FormEvent, useState } from "react";
import { ApiError } from "../api/auth.js";
import { Button } from "../components/ui/button.js";
import { useAuth } from "./AuthContext.js";
import { Field, FormError, inputClassName } from "./form-controls.js";

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
    <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
      <h2 className="m-0 text-base font-bold text-foreground">Enter your authenticator code</h2>
      <Field label="6-digit code" htmlFor="totp-code">
        <input
          id="totp-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          className={inputClassName}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
        />
      </Field>
      {error && <FormError>{error}</FormError>}
      <Button type="submit" disabled={submitting} className="w-full">
        Verify
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={cancelTotpLogin}
        disabled={submitting}
        className="w-full"
      >
        Back
      </Button>
    </form>
  );
}
