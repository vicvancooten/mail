import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "../api/auth.js";
import { reauthConnectedAccount } from "../api/connected-accounts.js";

/**
 * The CalDAV/CardDAV half of #204's Fix flow: account-level (ADR-0022: "a
 * CalDAV/CardDAV 401 is always the account level, since both Facets share
 * the password"), so this is the only reauth form that never asks for a
 * username — CalDAV/CardDAV's identity is the username already on file,
 * unchanged since the account was added. Mirrors
 * `mail-accounts/ReauthMailAccountForm.tsx`'s shape otherwise.
 */
export function ReauthCalDavAccountForm({
  connectedAccountId,
  onResumed,
}: {
  connectedAccountId: string;
  onResumed: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await reauthConnectedAccount(connectedAccountId, { password });
      onResumed();
    } catch (err) {
      if (err instanceof ApiError && err.code === "credentials_rejected") {
        setError("Still rejected — check the app password.");
      } else if (err instanceof ApiError && err.code === "unreachable") {
        setError("Couldn't connect to the server.");
      } else {
        setError("Couldn't re-authenticate this account.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`caldav-reauth-password-${connectedAccountId}`}>App password</Label>
        <Input
          id={`caldav-reauth-password-${connectedAccountId}`}
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
