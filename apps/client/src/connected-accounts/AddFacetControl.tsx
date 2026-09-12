import type {
  ConnectedAccount,
  ConnectedAccountFacetKind,
  Provider,
  ProviderAvailability,
} from "@mail/shared";
import type * as React from "react";
import { forwardRef, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { fetchProviderAvailability, startFacetGrant } from "../api/oauth-signin.js";
import { ImapMailAccountForm } from "../mail-accounts/ImapMailAccountForm.js";
import { ProviderSignInChoice } from "../mail-accounts/ProviderSignInChoice.js";
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
 * flow; #203's CalDAV/CardDAV flow; #299's purposeful-add-flows pass): a
 * dashed "+" per table cell, and — with `variant="button"` — the
 * below-table entry point phrased in Facets ("Add a mail account" / "Add a
 * calendar" / "Add contacts") rather than Provider or protocol names (#201's
 * own acceptance criterion).
 *
 * For Calendar/Contacts, every Provider that can serve the Facet still gets
 * its own section in the same Popover regardless of which row's "+" opened
 * it (`CalendarContactsFacetContent`) — CalDAV/CardDAV's own multi-step
 * server/username/password form now opens as a Dialog rather than replacing
 * the Popover's own content in place (#299's shell render seam: a single
 * sign-in step stays a Popover, a multi-step form is a Dialog).
 *
 * For Mail, `provider` (passed by `ConnectedAccountsTable`'s own per-row
 * loop) scopes the door to that row's own Provider: Google/Microsoft open a
 * Popover with just that one Provider's sign-in step, Other IMAP opens
 * straight into `ImapMailAccountForm` as a Dialog — no chooser first, since
 * the row itself already says which flow this is. Leaving `provider`
 * unset (the below-table generic button) keeps the full three-way choice,
 * still shell-seamed the same way: the choice itself is a Popover, and
 * choosing "Other" swaps to a Dialog rather than growing the Popover.
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
  /** The row this control sits in (`ConnectedAccountsTable`'s own loop) — only meaningful for `facet === "mail"`, where it scopes the door to one Provider. Unset for the below-table generic button, which still offers every Provider. */
  provider?: Provider;
  /** Every Connected Account this User has (#202, #203) — lets a Calendar/Contacts "+" list identities that qualify (Google/Microsoft: don't already carry the Facet; CalDAV/CardDAV: attach a second Facet) instead of asking for credentials again. Unused for `facet === "mail"`. */
  connectedAccounts?: ConnectedAccount[];
  /** The one step that leaves the app for a Google/Microsoft consent flow, injectable the same way `ProviderSignInChoice` already is. */
  navigate?: (url: string) => void;
}) {
  if (facet === "mail" && provider === "other_imap") {
    return <AddImapAccountDialog label={label} variant={variant} />;
  }

  if (facet === "mail" && (provider === "google" || provider === "microsoft")) {
    return (
      <AddSingleProviderMailPopover
        provider={provider}
        isOwner={isOwner}
        label={label}
        variant={variant}
      />
    );
  }

  if (facet === "mail") {
    return <AddMailAccountShell isOwner={isOwner} label={label} variant={variant} />;
  }

  return (
    <AddCalendarContactsFacetPopover
      facet={facet}
      isOwner={isOwner}
      variant={variant}
      label={label}
      connectedAccounts={connectedAccounts}
      navigate={navigate}
    />
  );
}

/**
 * The visible "+"/button trigger every door opens from. `forwardRef` and a
 * spread of every extra prop matter here specifically: this is always the
 * immediate child of a `PopoverTrigger`/`DialogTrigger` `asChild`, and
 * Radix's `Slot` clones exactly that one element to merge in `onClick`,
 * `aria-*`, `data-*` and the `ref` it needs for outside-click detection — a
 * component that doesn't forward them silently drops all of it.
 */
const AddTrigger = forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & { variant: "badge" | "button"; label?: string }
>(function AddTrigger({ variant, label, ...props }, ref) {
  return variant === "badge" ? (
    <Badge
      ref={ref as never}
      variant="outline"
      className="cursor-pointer border-dashed text-muted-foreground hover:text-foreground"
      {...props}
    >
      +
    </Badge>
  ) : (
    <Button ref={ref} type="button" variant="outline" size="sm" {...props}>
      {label}
    </Button>
  );
});

/** The Other-IMAP row's own door (#299): straight into the multi-step form, in a Dialog, no chooser first. */
function AddImapAccountDialog({ variant, label }: { variant: "badge" | "button"; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <AddTrigger variant={variant} label={label} />
      </DialogTrigger>
      <DialogContent>
        <ImapMailAccountForm onAdded={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** A Google/Microsoft row's own door (#299): a Popover holding just that one Provider's sign-in step. */
function AddSingleProviderMailPopover({
  provider,
  isOwner,
  variant,
  label,
}: {
  provider: Extract<Provider, "google" | "microsoft">;
  isOwner: boolean;
  variant: "badge" | "button";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <AddTrigger variant={variant} label={label} />
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <ProviderSignInChoice isOwner={isOwner} providers={[provider]} showOther={false} />
      </PopoverContent>
    </Popover>
  );
}

/** The below-table generic Mail door: the full three-way choice, still shell-seamed — a Popover for the choice, a Dialog once "Other" is picked. */
function AddMailAccountShell({
  isOwner,
  variant,
  label,
}: {
  isOwner: boolean;
  variant: "badge" | "button";
  label?: string;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <AddTrigger variant={variant} label={label} />
        </PopoverTrigger>
        <PopoverContent className="w-96">
          <ProviderSignInChoice
            isOwner={isOwner}
            onChooseOther={() => {
              setPopoverOpen(false);
              setDialogOpen(true);
            }}
          />
        </PopoverContent>
      </Popover>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <ImapMailAccountForm onAdded={() => setDialogOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Calendar/Contacts' own door: a Provider choice, mirroring
 * `ProviderSignInChoice`'s own shape for Mail. CalDAV/CardDAV (#203) is a
 * button that opens a Dialog for `AddCalDavFacetForm`'s server/username/password
 * flow (#299: a multi-step form, so a Dialog rather than growing the
 * Popover); Google and Microsoft (#202) turn on by incremental consent
 * against an identity the User has *already* connected — never a second
 * sign-in — rendered inline, side by side with CalDAV/CardDAV's own button,
 * since neither needs a form step first.
 */
function AddCalendarContactsFacetPopover({
  facet,
  isOwner,
  variant,
  label,
  connectedAccounts,
  navigate,
}: {
  facet: Extract<ConnectedAccountFacetKind, "calendar" | "contacts">;
  isOwner: boolean;
  variant: "badge" | "button";
  label?: string;
  connectedAccounts: ConnectedAccount[];
  navigate: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [calDavDialogOpen, setCalDavDialogOpen] = useState(false);
  const [availability, setAvailability] = useState<ProviderAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <AddTrigger variant={variant} label={label} />
        </PopoverTrigger>
        <PopoverContent className="w-96">
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
            {providersServingFacet(facet).map((candidateProvider) => {
              if (candidateProvider === "caldav_carddav") {
                return (
                  <Button
                    key={candidateProvider}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setOpen(false);
                      setCalDavDialogOpen(true);
                    }}
                  >
                    {PROVIDER_TABLE_LABEL[candidateProvider]}
                  </Button>
                );
              }
              if (!isOAuthProvider(candidateProvider) || !availability) {
                return null;
              }

              const oneProvider = candidateProvider;
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
        </PopoverContent>
      </Popover>

      <Dialog open={calDavDialogOpen} onOpenChange={setCalDavDialogOpen}>
        <DialogContent>
          <AddCalDavFacetForm
            facet={facet}
            connectedAccounts={connectedAccounts}
            onAdded={() => setCalDavDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>
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
