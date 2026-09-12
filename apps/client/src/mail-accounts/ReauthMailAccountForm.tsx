import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "../api/auth.js";
import { reauthMailAccount } from "../api/mail-accounts.js";

/**
 * The Needs Reauth re-enter-credentials flow (CONTEXT.md): the account's
 * host/port/TLS config is unchanged, only the credential is re-checked and
 * replaced. Resumes (status back to `active`) the moment the mail server
 * accepts it.
 */
export function ReauthMailAccountForm({
  mailAccountId,
  onResumed,
}: {
  mailAccountId: string;
  onResumed: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await reauthMailAccount(mailAccountId, { username, password });
      onResumed();
    } catch (err) {
      if (err instanceof ApiError && err.code === "credentials_rejected") {
        setError("Still rejected — check the username and password.");
      } else if (err instanceof ApiError && err.code === "connection_failed") {
        setError("Couldn't connect to the mail server.");
      } else {
        setError("Couldn't re-authenticate this Mail Account.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`reauth-username-${mailAccountId}`}>Username</Label>
        <Input
          id={`reauth-username-${mailAccountId}`}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`reauth-password-${mailAccountId}`}>Password</Label>
        <Input
          id={`reauth-password-${mailAccountId}`}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={submitting}>
        Reconnect
      </Button>
    </form>
  );
}
