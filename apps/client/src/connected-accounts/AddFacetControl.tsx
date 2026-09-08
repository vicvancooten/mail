import type {
  ConnectedAccount,
  ConnectedAccountFacetKind,
  Provider,
  ProviderAvailability,
} from "@mail/shared";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { fetchProviderAvailability, startFacetGrant } from "../api/oauth-signin.js";
import { AddMailAccountForm } from "../mail-accounts/AddMailAccountForm.js";
import { PROVIDER_LABEL } from "../mail-accounts/provider-labels.js";
import { AddCalDavFacetForm } from "./AddCalDavFacetForm.js";
import { describeFacetUnavailable } from "./facet-unavailable.js";
import { FACET_LABEL, PROVIDER_TABLE_LABEL, providersServingFacet } from "./provider-table.js";

type OAuthProvider = Extract<Provider, "google" | "microsoft">;

function isOAuthProvider(provider: Provider): provider is OAuthProvider {
  return provider === "google" || provider === "microsoft";
}

/**
 * The add-a-Facet door (#201, #172 Variant C; #202's real Calendar/Contacts
 * flow; #203's CalDAV/CardDAV flow): a dashed "+" per table cell, and — with
 * `variant="button"` — the below-table entry point phrased in Facets ("Add a
 * mail account" / "Add a calendar" / "Add contacts") rather than Provider or
 * protocol names (#201's own acceptance criterion). Neither a cell's
 * Provider row nor the below-table button distinguishes which Provider
 * actually serves the request — `AddMailAccountForm` always opens on its
 * own Google/Microsoft/Other choice regardless of which Mail cell's "+"
 * opened it, and Calendar/Contacts follow the same shape
 * (`CalendarContactsFacetContent`): every Provider that can serve the Facet
 * gets its own section in the same Popover, whichever row's "+" opened it.
 */
export function AddFacetControl({
  facet,
  isOwner,
  variant = "badge",
  label,
  connectedAccounts = [],
  navigate = (url) => window.location.assign(url),
}: {
  facet: ConnectedAccountFacetKind;
  isOwner: boolean;
  variant?: "badge" | "button";
  /** Only used by `variant="button"` — the below-table entry point's own wording. */
  label?: string;
  /** Every Connected Account this User has (#202, #203) — lets a Calendar/Contacts "+" list identities that qualify (Google/Microsoft: don't already carry the Facet; CalDAV/CardDAV: attach a second Facet) instead of asking for credentials again. Unused for `facet === "mail"`. */
  connectedAccounts?: ConnectedAccount[];
  /** The one step that leaves the app for a Google/Microsoft consent flow, injectable the same way `ProviderSignInChoice` already is. */
  navigate?: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {variant === "badge" ? (
          <Badge
            variant="outline"
            className="cursor-pointer border-dashed text-muted-foreground hover:text-foreground"
          >
            +
          </Badge>
        ) : (
          <Button type="button" variant="outline" size="sm">
            {label}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-96">
        {facet === "mail" ? (
          <AddMailAccountForm isOwner={isOwner} onAdded={() => setOpen(false)} />
        ) : (
          <CalendarContactsFacetContent
            facet={facet}
            isOwner={isOwner}
            connectedAccounts={connectedAccounts}
            navigate={navigate}
            onAdded={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Calendar/Contacts' own door: a Provider choice, mirroring
 * `ProviderSignInChoice`'s own shape for Mail. CalDAV/CardDAV (#203) is a
 * button that swaps the whole Popover for `AddCalDavFacetForm`'s
 * server/username/password flow; Google and Microsoft (#202) turn on by
 * incremental consent against an identity the User has *already*
 * connected — never a second sign-in — rendered inline, side by side with
 * CalDAV/CardDAV's own button, since neither needs a form step first.
 */
function CalendarContactsFacetContent({
  facet,
  isOwner,
  connectedAccounts,
  navigate,
  onAdded,
}: {
  facet: Extract<ConnectedAccountFacetKind, "calendar" | "contacts">;
  isOwner: boolean;
  connectedAccounts: ConnectedAccount[];
  navigate: (url: string) => void;
  onAdded: () => void;
}) {
  const [chosenCalDav, setChosenCalDav] = useState(false);
  const [availability, setAvailability] = useState<ProviderAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);

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

  if (chosenCalDav) {
    return (
      <AddCalDavFacetForm facet={facet} connectedAccounts={connectedAccounts} onAdded={onAdded} />
    );
  }

  async function handlePick(pickedProvider: OAuthProvider, connectedAccountId: string) {
    setError(null);
    setStartingId(connectedAccountId);
    try {
      const { authorizationUrl } = await startFacetGrant(pickedProvider, connectedAccountId, facet);
      // A full-page navigation, not a popup — the same reason
      // `ProviderSignInChoice` leaves the app this way (SameSite Lax).
      navigate(authorizationUrl);
    } catch {
      setError(`Couldn't start connecting ${FACET_LABEL[facet].toLowerCase()}.`);
      setStartingId(null);
    }
  }

  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Add {FACET_LABEL[facet].toLowerCase()}</PopoverTitle>
      </PopoverHeader>
      {availability === null && !error && <PopoverDescription>Loading…</PopoverDescription>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3">
        {providersServingFacet(facet).map((provider) => {
          if (provider === "caldav_carddav") {
            return (
              <Button
                key={provider}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setChosenCalDav(true)}
              >
                {PROVIDER_TABLE_LABEL[provider]}
              </Button>
            );
          }
          if (!isOAuthProvider(provider) || !availability) {
            return null;
          }

          const oneProvider = provider;
          const entry = availability.find((candidate) => candidate.provider === oneProvider);
          const providerLabel = PROVIDER_LABEL[oneProvider];

          if (!entry?.available) {
            const unavailable = describeFacetUnavailable(
              facet,
              oneProvider,
              entry?.unavailableReason ?? "not_registered",
              isOwner,
            );
            return (
              <FacetProviderSection
                key={oneProvider}
                label={providerLabel}
                unavailable={unavailable}
              />
            );
          }

          const apiEnabled =
            facet === "calendar" ? entry.calendarApiEnabled : entry.contactsApiEnabled;
          if (!apiEnabled) {
            const unavailable = describeFacetUnavailable(
              facet,
              oneProvider,
              "api_disabled",
              isOwner,
            );
            return (
              <FacetProviderSection
                key={oneProvider}
                label={providerLabel}
                unavailable={unavailable}
              />
            );
          }

          const atProvider = connectedAccounts.filter(
            (account) => account.provider === oneProvider,
          );
          const candidates = atProvider.filter(
            (account) => !account.facets.some((candidate) => candidate.kind === facet),
          );

          return (
            <section key={oneProvider} className="flex flex-col gap-1.5">
              <h4 className="text-sm font-medium text-foreground">{providerLabel}</h4>
              {atProvider.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Connect {providerLabel} for Mail first.
                </p>
              ) : candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Every {providerLabel} account already has {FACET_LABEL[facet].toLowerCase()}.
                </p>
              ) : (
                candidates.map((account) => (
                  <Button
                    key={account.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="justify-start"
                    disabled={startingId !== null}
                    onClick={() => void handlePick(oneProvider, account.id)}
                  >
                    {account.identity}
                  </Button>
                ))
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

function FacetProviderSection({
  label,
  unavailable,
}: {
  label: string;
  unavailable: { message: string; ownerHref: string | null };
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-sm font-medium text-foreground">{label}</h4>
      <p className="text-sm text-muted-foreground">
        {unavailable.message}{" "}
        {unavailable.ownerHref && (
          <a href={unavailable.ownerHref}>set it up on the Instance page</a>
        )}
      </p>
    </section>
  );
}
