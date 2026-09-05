import type { Provider, ProviderAvailability } from "@mail/shared";
import { useEffect, useState } from "react";
import { fetchProviderAvailability, startProviderSignIn } from "../api/oauth-signin.js";
import { PROVIDER_LABEL } from "./provider-labels.js";
import { describeProviderUnavailable } from "./provider-unavailable.js";

/**
 * The three-way choice a User meets when adding a Mail Account (#116,
 * ADR-0021): **Google**, **Microsoft**, **Other**. Google and Microsoft sign
 * in with the Provider and never ask for an address; Other keeps today's
 * autodiscover-then-manual flow entirely untouched.
 *
 * A Provider that can't be signed in with is *shown and disabled*, never
 * hidden — ADR-0021's own decision, because a Member has no way to fix a
 * missing Registration and needs to be told whom to ask. The Owner sees the
 * same disabled choice with a link to Provider Health instead.
 *
 * Choosing a Provider leaves the app: `startProviderSignIn` records the
 * attempt server-side and the browser navigates full-page to the Provider,
 * coming back to `/settings/mail-accounts?oauth=…` — which is why this
 * component has no success state of its own to render.
 */
export function ProviderSignInChoice({
  isOwner,
  onChooseOther,
  navigate = (url) => window.location.assign(url),
}: {
  /** The Owner is the one who *can* fix an unregistered Provider, so they get a link instead of "ask the Owner". */
  isOwner: boolean;
  onChooseOther: () => void;
  /** The one step that leaves the app. Injectable because jsdom's own `location.assign` can be neither called nor redefined. */
  navigate?: (url: string) => void;
}) {
  const [availability, setAvailability] = useState<ProviderAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startingProvider, setStartingProvider] = useState<Provider | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProviderAvailability()
      .then((result) => {
        if (!cancelled) setAvailability(result.providers);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't check which providers are available.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSignIn(provider: Provider) {
    setError(null);
    setStartingProvider(provider);
    try {
      const { authorizationUrl } = await startProviderSignIn(provider);
      // A full-page navigation, not a popup: ADR-0021's redirect flow, and
      // the reason the session cookie has to survive it (SameSite Lax).
      navigate(authorizationUrl);
    } catch {
      setError(`Couldn't start sign-in with ${PROVIDER_LABEL[provider]}.`);
      setStartingProvider(null);
    }
  }

  return (
    <div>
      <h3>Add a Mail Account</h3>
      {availability === null && !error && <p>Loading…</p>}
      {error && <p role="alert">{error}</p>}

      {availability?.map((entry) => (
        <div key={entry.provider}>
          <button
            type="button"
            disabled={!entry.available || startingProvider !== null}
            onClick={() => void handleSignIn(entry.provider)}
          >
            Sign in with {PROVIDER_LABEL[entry.provider]}
          </button>
          {!entry.available &&
            (() => {
              // Schema guarantee: `unavailableReason` is non-null exactly when `available` is false.
              const unavailable = describeProviderUnavailable(
                entry.provider,
                entry.unavailableReason ?? "not_registered",
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
            })()}
        </div>
      ))}

      <button type="button" onClick={onChooseOther} disabled={startingProvider !== null}>
        Other
      </button>
      <p>Any other mailbox — we'll look up its server settings from the address.</p>
    </div>
  );
}
