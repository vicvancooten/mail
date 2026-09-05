import type { MailAccountConnection, MailAccountSecurity } from "@mail/shared";
import { type FormEvent, useState } from "react";
import { ApiError } from "../api/auth.js";
import { createMailAccount, discoverMailAccount } from "../api/mail-accounts.js";
import { ProviderSignInChoice } from "./ProviderSignInChoice.js";

const BLANK_CONNECTION: MailAccountConnection = { host: "", port: 993, security: "tls" };

type Step =
  /** The three-way Google / Microsoft / Other choice (#116) — where adding an account now starts. */
  | { kind: "choice" }
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
 * Add-a-Mail-Account (poc-spec.md §Mail Accounts): a separate, repeatable
 * step from creating the User, run from `MailAccountsSection`.
 *
 * Since #116 it opens on the Provider choice (`ProviderSignInChoice`);
 * **Other** is what leads here, into the flow this form has always been.
 * That flow is deliberately unchanged: the autodiscover chain first, manual
 * entry as a first-class fallback step pre-filled with privateemail's
 * defaults when the domain's MX warrants it (docs/research/0004 §4), never
 * an apologetic dead end. Google and Microsoft never reach it at all — they
 * leave the app entirely and come back with the account already created.
 */
export function AddMailAccountForm({
  onAdded,
  isOwner = false,
}: {
  onAdded: () => void;
  /** Chooses the wording for an unregistered Provider (ADR-0021). Defaults to the Member's, the safe assumption. */
  isOwner?: boolean;
}) {
  const [step, setStep] = useState<Step>({ kind: "choice" });
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

  if (step.kind === "choice") {
    return (
      <ProviderSignInChoice isOwner={isOwner} onChooseOther={() => setStep({ kind: "email" })} />
    );
  }

  if (step.kind === "email") {
    return (
      <form onSubmit={handleDiscover}>
        <h3>Add a Mail Account</h3>
        <label htmlFor="mail-account-email">Email address</label>
        <input
          id="mail-account-email"
          type="email"
          value={emailInput}
          onChange={(event) => setEmailInput(event.target.value)}
          required
        />
        {error && <p role="alert">{error}</p>}
        <button type="button" onClick={() => setStep({ kind: "choice" })} disabled={submitting}>
          Back
        </button>
        <button type="submit" disabled={submitting}>
          Continue
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={handleCreate}>
      <h3>Add a Mail Account</h3>
      <p>{step.emailAddress}</p>
      {step.discoveredFrom ? (
        <p>
          Found server settings automatically ({step.discoveredFrom}). Review and confirm below.
        </p>
      ) : (
        <p>Couldn't find server settings automatically — enter them manually.</p>
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

      <div>
        <label htmlFor="mail-account-username">Username</label>
        <input
          id="mail-account-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="mail-account-password">Password</label>
        <input
          id="mail-account-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>

      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={() => setStep({ kind: "email" })} disabled={submitting}>
        Back
      </button>
      <button type="submit" disabled={submitting}>
        Verify and add
      </button>
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
    <fieldset>
      <legend>{legend}</legend>
      <div>
        <label htmlFor={`${idPrefix}-host`}>Host</label>
        <input
          id={`${idPrefix}-host`}
          value={connection.host}
          onChange={(event) => onChange({ host: event.target.value })}
          required
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-port`}>Port</label>
        <input
          id={`${idPrefix}-port`}
          type="number"
          min={1}
          max={65535}
          value={connection.port}
          onChange={(event) => onChange({ port: Number(event.target.value) })}
          required
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-security`}>Security</label>
        <select
          id={`${idPrefix}-security`}
          value={connection.security}
          onChange={(event) => onChange({ security: event.target.value as MailAccountSecurity })}
        >
          <option value="tls">TLS</option>
          <option value="starttls">STARTTLS</option>
          <option value="none">None</option>
        </select>
      </div>
    </fieldset>
  );
}
