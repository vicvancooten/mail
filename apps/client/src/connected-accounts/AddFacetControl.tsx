import type {
  ConnectedAccount,
  ConnectedAccountFacetKind,
  GrantableFacetKind,
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
import { describeFacetUnavailable } from "./facet-unavailable.js";
import { FACET_LABEL, PROVIDER_TABLE_LABEL, providersServingFacet } from "./provider-table.js";

type OAuthProvider = Extract<Provider, "google" | "microsoft">;

function isOAuthProvider(provider: Provider): provider is OAuthProvider {
  return provider === "google" || provider === "microsoft";
}

/**
 * The add-a-Facet door (#201, #172 Variant C; #202's real Calendar/Contacts
 * flow). A dashed "+" per table cell, and — with `variant="button"` — the
 * below-table entry point phrased in Facets ("Add a mail account" / "Add a
 * calendar" / "Add contacts") rather than Provider or protocol names (#201's
 * own acceptance criterion). Mail keeps its own form (`AddMailAccountForm`,
 * unchanged since #116/#119); Calendar and Contacts turn on by incremental
 * consent against an identity the User has *already* connected — never a
 * second sign-in, per #202's own acceptance criteria — so this needs the
 * User's full Connected Account list to know which identities qualify.
 */
export function AddFacetControl({
  facet,
  isOwner,
  variant = "badge",
  label,
  provider,
  connectedAccounts = [],
  navigate = (url) => window.location.assign(url),
}: {
  facet: ConnectedAccountFacetKind;
  isOwner: boolean;
  variant?: "badge" | "button";
  /** Only used by `variant="button"` — the below-table entry point's own wording. */
  label?: string;
  /**
   * Scopes the Popover to one Provider's own identities — always given by a
   * table cell (its row is one Provider). Omitted by the below-table
   * button, which shows every Provider serving this Facet at once. Ignored
   * for `facet === "mail"`; a non-OAuth Provider (CalDAV/CardDAV) renders a
   * not-yet-available notice instead of the real flow — #203's own door.
   */
  provider?: Provider;
  /** The User's full Connected Account list (#202) — only read for Calendar/Contacts, to find identities that don't already carry the Facet. */
  connectedAccounts?: ConnectedAccount[];
  /** The one step that leaves the app, injectable the same way `ProviderSignInChoice` already is. */
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
      <PopoverContent className={facet === "mail" ? "w-96" : "w-80"}>
        {facet === "mail" ? (
          <AddMailAccountForm isOwner={isOwner} onAdded={() => setOpen(false)} />
        ) : provider && !isOAuthProvider(provider) ? (
          <NotYetAvailableFacetNotice facet={facet} provider={provider} />
        ) : (
          <GrantFacetNotice
            facet={facet}
            isOwner={isOwner}
            provider={provider}
            connectedAccounts={connectedAccounts}
            navigate={navigate}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The CalDAV/CardDAV row's own Calendar/Contacts cell (#201's original
 * scope note, unchanged by #202): a real column, but nothing this ticket
 * can turn on — CalDAV/CardDAV discovery and consent are #203's separate
 * door.
 */
function NotYetAvailableFacetNotice({
  facet,
  provider,
}: {
  facet: GrantableFacetKind;
  provider: Exclude<Provider, OAuthProvider>;
}) {
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Add {FACET_LABEL[facet].toLowerCase()}</PopoverTitle>
      </PopoverHeader>
      <PopoverDescription>
        Not available yet — {FACET_LABEL[facet]} will connect through{" "}
        {PROVIDER_TABLE_LABEL[provider]}.
      </PopoverDescription>
    </>
  );
}

/**
 * Calendar/Contacts' own Popover body (#202): one section per Provider that
 * can serve this Facet — Google and Microsoft only, CalDAV/CardDAV's own
 * add flow is #203's separate door — each listing the User's connected
 * identities at that Provider which don't already carry the Facet.
 * Fetches Provider availability itself (`fetchProviderAvailability`, the
 * same call `ProviderSignInChoice` makes) since a Member needs to see a
 * Facet as unavailable without being Owner-only Provider Health.
 */
function GrantFacetNotice({
  facet,
  isOwner,
  provider,
  connectedAccounts,
  navigate,
}: {
  facet: GrantableFacetKind;
  isOwner: boolean;
  /** Non-OAuth Providers never reach here — `AddFacetControl` renders `NotYetAvailableFacetNotice` for those instead. */
  provider?: Provider;
  connectedAccounts: ConnectedAccount[];
  navigate: (url: string) => void;
}) {
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

  const providers = (provider ? [provider] : providersServingFacet(facet)).filter(isOAuthProvider);

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
        {availability &&
          providers.map((oneProvider) => {
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
