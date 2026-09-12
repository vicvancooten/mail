import type { MailAccountConnection, MailAccountSecurity } from "@mail/shared";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "../api/auth.js";
import { createMailAccount, discoverMailAccount } from "../api/mail-accounts.js";

const BLANK_CONNECTION: MailAccountConnection = { host: "", port: 993, security: "tls" };

type Step =
  | { kind: "email" }
  | {
      kind: "credentials";
      emailAddress: string;
      imap: MailAccountConnection;
      smtp: MailAccountConnection;
      /** Set only when autodiscover found this itself — shown as a confirmation, not asked for. */
      discoveredFrom: string | null;
    };

/**
 * The Other/IMAP half of `AddMailAccountForm` (#116), extracted so it can
 * also be the whole content of a standalone control — the "Other IMAP" row's
 * own add door (#299) opens straight on this, in a Dialog, with no chooser
 * step first since the row itself already says which flow this is.
 *
 * Unchanged behaviour: autodiscover first, manual entry as a first-class
 * fallback pre-filled with privateemail's defaults when the domain's MX
 * warrants it, never an apologetic dead end.
 */
export function ImapMailAccountForm({
  onAdded,
  onBack,
}: {
  onAdded: () => void;
  /** Only set when this is reached from `AddMailAccountForm`'s own choice step — omit to hide "Back" entirely (the standalone Dialog control has nowhere to go back to). */
  onBack?: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [emailInput, setEmailInput] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleDiscover(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await discoverMailAccount({ emailAddress: emailInput });
      setUsername(emailInput);
      if (result.found) {
        setStep({
          kind: "credentials",
          emailAddress: emailInput,
          imap: result.imap,
          smtp: result.smtp,
          discoveredFrom: result.source,
        });
      } else {
        setStep({
          kind: "credentials",
          emailAddress: emailInput,
          imap: result.prefill?.imap ?? BLANK_CONNECTION,
          smtp: result.prefill?.smtp ?? { ...BLANK_CONNECTION, port: 587, security: "starttls" },
          discoveredFrom: null,
        });
      }
    } catch {
      setError("Couldn't reach the server to look up this domain.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (step.kind !== "credentials") return;
    setError(null);
    setSubmitting(true);
    try {
      await createMailAccount({
        emailAddress: step.emailAddress,
        imap: step.imap,
        smtp: step.smtp,
        username,
        password,
      });
      onAdded();
    } catch (err) {
      if (err instanceof ApiError && err.code === "credentials_rejected") {
        setError("That username/password was rejected by the mail server.");
      } else if (err instanceof ApiError && err.code === "connection_failed") {
        setError("Couldn't connect to that mail server — check the host and port.");
      } else {
        setError("Couldn't add this Mail Account.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function updateConnection(which: "imap" | "smtp", patch: Partial<MailAccountConnection>) {
    if (step.kind !== "credentials") return;
    setStep({ ...step, [which]: { ...step[which], ...patch } });
  }

  if (step.kind === "email") {
    return (
      <form onSubmit={handleDiscover} className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Add a Mail Account</h3>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mail-account-email">Email address</Label>
          <Input
            id="mail-account-email"
            type="email"
            value={emailInput}
            onChange={(event) => setEmailInput(event.target.value)}
            required
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          {onBack && (
            <Button type="button" variant="outline" onClick={onBack} disabled={submitting}>
              Back
            </Button>
          )}
          <Button type="submit" disabled={submitting}>
            Continue
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleCreate} className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Add a Mail Account</h3>
      <p className="text-sm text-muted-foreground">{step.emailAddress}</p>
      {step.discoveredFrom ? (
        <p className="text-sm text-muted-foreground">
          Found server settings automatically ({step.discoveredFrom}). Review and confirm below.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Couldn't find server settings automatically — enter them manually.
        </p>
      )}

      <ConnectionFields
        legend="Incoming (IMAP)"
        idPrefix="imap"
        connection={step.imap}
        onChange={(patch) => updateConnection("imap", patch)}
      />
      <ConnectionFields
        legend="Outgoing (SMTP)"
        idPrefix="smtp"
        connection={step.smtp}
        onChange={(patch) => updateConnection("smtp", patch)}
      />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mail-account-username">Username</Label>
        <Input
          id="mail-account-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mail-account-password">Password</Label>
        <Input
          id="mail-account-password"
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
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setStep({ kind: "email" })}
          disabled={submitting}
        >
          Back
        </Button>
        <Button type="submit" disabled={submitting}>
          Verify and add
        </Button>
      </div>
    </form>
  );
}

function ConnectionFields({
  legend,
  idPrefix,
  connection,
  onChange,
}: {
  legend: string;
  idPrefix: string;
  connection: MailAccountConnection;
  onChange: (patch: Partial<MailAccountConnection>) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-foreground">{legend}</legend>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-host`}>Host</Label>
        <Input
          id={`${idPrefix}-host`}
          value={connection.host}
          onChange={(event) => onChange({ host: event.target.value })}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-port`}>Port</Label>
        <Input
          id={`${idPrefix}-port`}
          type="number"
          min={1}
          max={65535}
          value={connection.port}
          onChange={(event) => onChange({ port: Number(event.target.value) })}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-security`}>Security</Label>
        <Select
          value={connection.security}
          onValueChange={(value) => onChange({ security: value as MailAccountSecurity })}
        >
          <SelectTrigger id={`${idPrefix}-security`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tls">TLS</SelectItem>
            <SelectItem value="starttls">STARTTLS</SelectItem>
            <SelectItem value="none">None</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </fieldset>
  );
}
