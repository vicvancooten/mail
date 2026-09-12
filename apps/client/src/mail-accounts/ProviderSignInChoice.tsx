import type { ProviderAvailability, RegisteredProvider } from "@mail/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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
 *
 * #299: `providers` narrows which Provider rows render at all — the "Google"
 * and "Microsoft" table rows each open this scoped to just their own
 * Provider (`showOther={false}`, so neither the other Provider nor "Other"
 * appears), rather than the full three-way choice `AddMailAccountForm`'s own
 * generic door still opens with every argument left at its default.
 */
export function ProviderSignInChoice({
  isOwner,
  onChooseOther,
  navigate = (url) => window.location.assign(url),
  providers = ["google", "microsoft"],
  showOther = true,
}: {
  /** The Owner is the one who *can* fix an unregistered Provider, so they get a link instead of "ask the Owner". */
  isOwner: boolean;
  /** Required only when `showOther` (the default) leaves "Other" on screen. */
  onChooseOther?: () => void;
  /** The one step that leaves the app. Injectable because jsdom's own `location.assign` can be neither called nor redefined. */
  navigate?: (url: string) => void;
  /** Which Provider rows to render — defaults to both. A single-Provider control (a table row's own "+") narrows this to just its own Provider. */
  providers?: readonly RegisteredProvider[];
  /** Whether the "Other" (IMAP) door renders at all — off for a single-Provider control, which has no "other provider" to offer. */
  showOther?: boolean;
}) {
  const [availability, setAvailability] = useState<ProviderAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startingProvider, setStartingProvider] = useState<RegisteredProvider | null>(null);

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

  async function handleSignIn(provider: RegisteredProvider) {
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

  const shownAvailability = availability?.filter((entry) => providers.includes(entry.provider));

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Add a Mail Account</h3>
      {availability === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {shownAvailability?.map((entry) => (
        <div key={entry.provider} className="flex flex-col gap-1">
          <Button
            type="button"
            variant="outline"
            disabled={!entry.available || startingProvider !== null}
            onClick={() => void handleSignIn(entry.provider)}
          >
            Sign in with {PROVIDER_LABEL[entry.provider]}
          </Button>
          {!entry.available &&
            (() => {
              // Schema guarantee: `unavailableReason` is non-null exactly when `available` is false.
              const unavailable = describeProviderUnavailable(
                entry.provider,
                entry.unavailableReason ?? "not_registered",
                isOwner,
              );
              return (
                <p className="text-sm text-muted-foreground">
                  {unavailable.message}{" "}
                  {unavailable.ownerHref && (
                    <a href={unavailable.ownerHref}>set it up on the Instance page</a>
                  )}
                </p>
              );
            })()}
        </div>
      ))}

      {showOther && (
        <>
          <Button
            type="button"
            variant="outline"
            onClick={onChooseOther}
            disabled={startingProvider !== null}
          >
            Other
          </Button>
          <p className="text-sm text-muted-foreground">
            Any other mailbox — we'll look up its server settings from the address.
          </p>
        </>
      )}
    </div>
  );
}
