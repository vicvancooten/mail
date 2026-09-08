import type { ConnectedAccount, ConnectedAccountFacetKind } from "@mail/shared";
import { useState } from "react";
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
import { AddMailAccountForm } from "../mail-accounts/AddMailAccountForm.js";
import { AddCalDavFacetForm } from "./AddCalDavFacetForm.js";
import { FACET_LABEL, PROVIDER_TABLE_LABEL, providersServingFacet } from "./provider-table.js";

/**
 * The add-a-Facet door (#201, #172 Variant C): a dashed "+" per table cell,
 * and — with `variant="button"` — the below-table entry point phrased in
 * Facets ("Add a mail account" / "Add a calendar" / "Add contacts") rather
 * than Provider or protocol names (#201's own acceptance criterion). Neither
 * a cell's Provider row nor the below-table button distinguishes which
 * Provider actually serves the request — `AddMailAccountForm` always opens
 * on its own Google/Microsoft/Other choice regardless of which Mail cell's
 * "+" opened it, and Calendar/Contacts follow the same shape: CalDAV/CardDAV
 * is the one real door today (#203); Google and Microsoft still render
 * `ComingSoonFacetNotice`, the flow #202 fills in next.
 */
export function AddFacetControl({
  facet,
  isOwner,
  variant = "badge",
  label,
  connectedAccounts = [],
}: {
  facet: ConnectedAccountFacetKind;
  isOwner: boolean;
  variant?: "badge" | "button";
  /** Only used by `variant="button"` — the below-table entry point's own wording. */
  label?: string;
  /** CalDAV/CardDAV's own accounts already connected for this User (#203) — lets a Calendar/Contacts "+" offer attaching a second Facet instead of asking for a server and password again. Unused for `facet === "mail"`. */
  connectedAccounts?: ConnectedAccount[];
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
            connectedAccounts={connectedAccounts}
            onAdded={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Calendar/Contacts' own door (#203): a Provider choice, mirroring
 * `ProviderSignInChoice`'s own shape for Mail — CalDAV/CardDAV is the one
 * choice with a real flow behind it (`AddCalDavFacetForm`); Google and
 * Microsoft still read "not available yet" until #202 lands.
 */
function CalendarContactsFacetContent({
  facet,
  connectedAccounts,
  onAdded,
}: {
  facet: Extract<ConnectedAccountFacetKind, "calendar" | "contacts">;
  connectedAccounts: ConnectedAccount[];
  onAdded: () => void;
}) {
  const [chosenCalDav, setChosenCalDav] = useState(false);

  if (chosenCalDav) {
    return (
      <AddCalDavFacetForm facet={facet} connectedAccounts={connectedAccounts} onAdded={onAdded} />
    );
  }

  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Add {FACET_LABEL[facet].toLowerCase()}</PopoverTitle>
      </PopoverHeader>
      {providersServingFacet(facet).map((provider) =>
        provider === "caldav_carddav" ? (
          <Button
            key={provider}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setChosenCalDav(true)}
          >
            {PROVIDER_TABLE_LABEL[provider]}
          </Button>
        ) : (
          <PopoverDescription key={provider}>
            Not available yet — {PROVIDER_TABLE_LABEL[provider]} {FACET_LABEL[facet].toLowerCase()}.
          </PopoverDescription>
        ),
      )}
    </>
  );
}
