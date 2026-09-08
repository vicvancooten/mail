import type { ConnectedAccountFacetKind } from "@mail/shared";
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
import { FACET_LABEL, PROVIDER_TABLE_LABEL, providersServingFacet } from "./provider-table.js";

/**
 * The add-a-Facet door (#201, #172 Variant C): a dashed "+" per table cell,
 * and — with `variant="button"` — the below-table entry point phrased in
 * Facets ("Add a mail account" / "Add a calendar" / "Add contacts") rather
 * than Provider or protocol names (#201's own acceptance criterion). Only
 * Mail has a working add flow today (`AddMailAccountForm`, unchanged since
 * #116/#119) — Calendar and Contacts are real columns with nothing behind
 * their "+" yet (the flows that fill them are the slices after this one,
 * per #201's own scope note), so their Popover just names which Providers
 * will eventually serve them.
 */
export function AddFacetControl({
  facet,
  isOwner,
  variant = "badge",
  label,
}: {
  facet: ConnectedAccountFacetKind;
  isOwner: boolean;
  variant?: "badge" | "button";
  /** Only used by `variant="button"` — the below-table entry point's own wording. */
  label?: string;
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
      <PopoverContent className={facet === "mail" ? "w-96" : undefined}>
        {facet === "mail" ? (
          <AddMailAccountForm isOwner={isOwner} onAdded={() => setOpen(false)} />
        ) : (
          <ComingSoonFacetNotice facet={facet} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function ComingSoonFacetNotice({ facet }: { facet: ConnectedAccountFacetKind }) {
  const providers = providersServingFacet(facet)
    .map((provider) => PROVIDER_TABLE_LABEL[provider])
    .join(", ");

  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Add {FACET_LABEL[facet].toLowerCase()}</PopoverTitle>
      </PopoverHeader>
      <PopoverDescription>
        Not available yet — {FACET_LABEL[facet]} will connect through {providers}.
      </PopoverDescription>
    </>
  );
}
