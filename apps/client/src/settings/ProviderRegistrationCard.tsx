import type { Provider, ProviderHealth } from "@mail/shared";
import { type FormEvent, useState } from "react";
import {
  deleteProviderRegistration,
  fetchProviderDeletePreview,
  saveProviderRegistration,
} from "../api/providers.js";

const PROVIDER_LABEL: Record<Provider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

/** The in-app setup steps (ADR-0021's own summary of each Provider's console) — no live UI to link deeper into, since neither console is ours to drive. */
const PROVIDER_STEPS: Record<Provider, { consoleName: string; steps: string[] }> = {
  google: {
    consoleName: "Google Cloud console",
    steps: [
      'Create (or open) a project, then "APIs & Services" → "Credentials".',
      'Create an OAuth client ID of type "Web application" and add the redirect URI below under "Authorized redirect URIs".',
      "On the OAuth consent screen, set the app to In Production — left in Testing, its refresh tokens expire after seven days.",
      "Paste the client ID and secret below.",
    ],
  },
  microsoft: {
    consoleName: "Microsoft Entra admin center",
    steps: [
      "Register a new application, supporting personal and work/school accounts.",
      'Add the redirect URI below as a "Web" platform redirect URI.',
      'Create a client secret under "Certificates & secrets".',
      "Paste the client ID and secret below.",
    ],
  },
};

const INSTALLATION_DOCS_URL =
  "https://github.com/vicvancooten/mail/blob/main/docs/installation.md#enabling-gmail-and-outlook-sign-in-optional";

/**
 * One Provider's row in the Instance page's Providers section (#115, ADR-0021):
 * status, the save form (first registration, or "Replace" over an existing
 * one — the secret is write-only, same idiom as a Mail Account's own
 * credential), the redirect URI to copy, the plain-http warning, and the
 * setup steps. Delete is a two-step confirm: preview the affected Mail
 * Account count, then confirm — never a single destructive click.
 */
export function ProviderRegistrationCard({
  health,
  isSecureContext,
  onChanged,
}: {
  health: ProviderHealth;
  /** `info.publicUrl.isSecureContext` (`instance-info.ts`): false means plain http on a non-loopback host — exactly the case Google rejects a redirect for. */
  isSecureContext: boolean;
  onChanged: () => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deletePreviewCount, setDeletePreviewCount] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const provider = health.provider;
  const label = PROVIDER_LABEL[provider];
  const steps = PROVIDER_STEPS[provider];
  const registered = health.status === "registered_untested";
  const editing = !registered || replacing;

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await saveProviderRegistration(provider, { clientId, clientSecret });
      setReplacing(false);
      setClientId("");
      setClientSecret("");
      onChanged();
    } catch {
      setError(`Couldn't save the ${label} Registration.`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePreviewDelete() {
    setError(null);
    try {
      const preview = await fetchProviderDeletePreview(provider);
      setDeletePreviewCount(preview.mailAccountCount);
    } catch {
      setError(`Couldn't check Mail Accounts on ${label}.`);
    }
  }

  async function handleConfirmDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deleteProviderRegistration(provider);
      setDeletePreviewCount(null);
      onChanged();
    } catch {
      setError(`Couldn't remove the ${label} Registration.`);
    } finally {
      setDeleting(false);
    }
  }

  async function handleCopyRedirectUri() {
    try {
      await navigator.clipboard.writeText(health.redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied — the field itself is still selectable by hand.
    }
  }

  return (
    <section className="provider-card">
      <h4>{label}</h4>
      <p className="provider-status">
        {registered ? "Registered, untested" : "Not registered"}
        {registered && !replacing && health.clientIdPreview ? (
          <>
            {" — "}
            <code>{health.clientIdPreview}</code>
          </>
        ) : null}
      </p>

      <div className="provider-redirect-uri">
        <label htmlFor={`${provider}-redirect-uri`}>Redirect URI</label>
        <div>
          <code id={`${provider}-redirect-uri`}>{health.redirectUri}</code>
          <button type="button" onClick={() => void handleCopyRedirectUri()}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {!isSecureContext && (
          <p role="alert">
            Your Public URL is plain http on a non-loopback host — {PROVIDER_LABEL[provider]} will
            reject this redirect URI until it's https.
          </p>
        )}
      </div>

      {error && <p role="alert">{error}</p>}

      {editing ? (
        <form onSubmit={handleSave} className="provider-form">
          <label htmlFor={`${provider}-client-id`}>Client ID</label>
          <input
            id={`${provider}-client-id`}
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            required
          />
          <label htmlFor={`${provider}-client-secret`}>Client secret</label>
          <input
            id={`${provider}-client-secret`}
            type="password"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            required
          />
          <button type="submit" disabled={submitting}>
            Save
          </button>
          {replacing && (
            <button type="button" onClick={() => setReplacing(false)} disabled={submitting}>
              Cancel
            </button>
          )}
        </form>
      ) : (
        <button type="button" onClick={() => setReplacing(true)}>
          Replace
        </button>
      )}

      {registered && !editing && (
        <div className="provider-delete">
          {deletePreviewCount === null ? (
            <button
              type="button"
              data-destructive="true"
              onClick={() => void handlePreviewDelete()}
            >
              Remove Registration
            </button>
          ) : (
            <p role="alert">
              {deletePreviewCount === 0
                ? "No Mail Accounts use this Provider."
                : `${deletePreviewCount} Mail Account${deletePreviewCount === 1 ? "" : "s"} will stop syncing and move to Needs Reauth.`}{" "}
              <button
                type="button"
                data-destructive="true"
                disabled={deleting}
                onClick={() => void handleConfirmDelete()}
              >
                Confirm removal
              </button>
              <button type="button" disabled={deleting} onClick={() => setDeletePreviewCount(null)}>
                Cancel
              </button>
            </p>
          )}
        </div>
      )}

      <details className="provider-setup-steps">
        <summary>Setup steps ({steps.consoleName})</summary>
        <ol>
          {steps.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p>
          See{" "}
          <a href={INSTALLATION_DOCS_URL} target="_blank" rel="noreferrer">
            the installation docs
          </a>{" "}
          for a full walkthrough.
        </p>
      </details>
    </section>
  );
}
