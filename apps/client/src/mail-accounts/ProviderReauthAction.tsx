import type { Provider } from "@mail/shared";
import { useEffect, useState } from "react";
import { fetchProviderAvailability, startProviderSignIn } from "../api/oauth-signin.js";
import { describeProviderUnavailable } from "./provider-unavailable.js";

/**
 * The reauth half of the Provider sign-in door (#119, ADR-0021 user stories
 * 27–29): a single Provider, never a three-way choice, and never a password
 * field. Two callers use it with the same mechanics and different labels:
 *
 * - An OAuth Mail Account in Needs Reauth — "Sign in with Google/Microsoft
 *   again", the Provider fixed to the one its Grant already names.
 * - A password Mail Account's settings row — "Switch to Google sign-in",
 *   offering to replace the password with a Grant if the signed-in address
 *   matches.
 *
 * Both leave the app on click, the same full-page redirect
 * `ProviderSignInChoice` uses, and come back through the same
 * `/settings/mail-accounts?oauth=…` outcome the Mail Accounts section
 * already reads. An unregistered Provider renders with the exact wording
 * `ProviderSignInChoice` shows when adding a Mail Account (#119's own
 * acceptance criterion).
 */
export function ProviderReauthAction({
  mailAccountId,
  provider,
  label,
  isOwner,
  navigate = (url) => window.location.assign(url),
}: {
  mailAccountId: string;
  provider: Provider;
  label: string;
  isOwner: boolean;
  navigate?: (url: string) => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<
    Parameters<typeof describeProviderUnavailable>[1] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchProviderAvailability()
      .then((result) => {
        if (cancelled) return;
        const entry = result.providers.find((candidate) => candidate.provider === provider);
        setAvailable(entry?.available ?? false);
        setUnavailableReason(entry?.unavailableReason ?? "not_supported");
      })
      .catch(() => {
        if (!cancelled) {
          setAvailable(false);
          setUnavailableReason("not_supported");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  async function handleClick() {
    setError(null);
    setStarting(true);
    try {
      const { authorizationUrl } = await startProviderSignIn(provider, { mailAccountId });
      navigate(authorizationUrl);
    } catch {
      setError("Couldn't start sign-in.");
      setStarting(false);
    }
  }

  if (available === null) {
    return null;
  }

  if (!available) {
    const unavailable = describeProviderUnavailable(
      provider,
      unavailableReason ?? "not_supported",
      isOwner,
    );
    return (
      <p>
        {unavailable.message}{" "}
        {unavailable.ownerHref && (
          <a href={unavailable.ownerHref}>set it up on the Instance page</a>
        )}
      </p>
    );
  }

  return (
    <p>
      <button type="button" onClick={() => void handleClick()} disabled={starting}>
        {label}
      </button>
      {error && <span role="alert"> {error}</span>}
    </p>
  );
}
