import type { ConnectedAccountFacetKind, ProviderHealth } from "@mail/shared";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FACET_LABEL, PROVIDER_TABLE_LABEL } from "./provider-table.js";

const STATUS_DOT_COLOR: Record<ProviderHealth["status"], string> = {
  not_registered: "bg-muted-foreground",
  registered_untested: "bg-muted-foreground",
  working: "bg-[var(--color-success)]",
  failing: "bg-destructive",
};

const STATUS_LABEL: Record<ProviderHealth["status"], string> = {
  not_registered: "Not registered",
  registered_untested: "Registered, untested",
  working: "Working",
  failing: "Failing",
};

/** The Owner's own declared "API enabled" flag for a Facet — always `null` for Mail, which needs no Provider-side API switched on (ADR-0022). */
function facetApiEnabled(health: ProviderHealth, facet: ConnectedAccountFacetKind): boolean | null {
  if (facet === "calendar") return health.calendarApiEnabled;
  if (facet === "contacts") return health.contactsApiEnabled;
  return null;
}

/**
 * The settings table's Owner-only Provider Health dot (#205, ADR-0022,
 * CONTEXT.md's Provider Health) — "a small dot beside the Provider name ...
 * present, not prominent", opening its own Popover with the per-Facet
 * reading Provider Health gained in this ticket: status, ever granted, how
 * many Connected Accounts, how many parked, and — for Calendar/Contacts —
 * whether the Owner has declared the Provider-side API enabled.
 *
 * `ConnectedAccountsTable` renders this only for `isOwner` and only for the
 * two `RegisteredProvider`s (Google, Microsoft) — CalDAV/CardDAV and Other
 * IMAP never have a Provider Registration and stay absent from Provider
 * Health entirely (ADR-0022's own line).
 */
export function ProviderHealthDot({ health }: { health: ProviderHealth }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${PROVIDER_TABLE_LABEL[health.provider]} Provider Health`}
          className="inline-flex cursor-pointer items-center rounded-full p-0.5"
        >
          <span className={`size-2 rounded-full ${STATUS_DOT_COLOR[health.status]}`} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>{PROVIDER_TABLE_LABEL[health.provider]} Provider Health</PopoverTitle>
          <PopoverDescription>{STATUS_LABEL[health.status]}</PopoverDescription>
        </PopoverHeader>
        <ul className="flex flex-col gap-2 text-sm">
          {health.facets.map((facet) => {
            const apiEnabled = facetApiEnabled(health, facet.facet);
            return (
              <li key={facet.facet} className="flex flex-col gap-0.5">
                <span className="font-medium">{FACET_LABEL[facet.facet]}</span>
                <span className="text-muted-foreground">
                  {facet.everGranted ? "Granted" : "Never granted"} · {facet.connectedAccountCount}{" "}
                  connected
                  {facet.parkedCount > 0 && `, ${facet.parkedCount} parked`}
                </span>
                {apiEnabled !== null && (
                  <span className="text-muted-foreground">
                    API enabled: {apiEnabled ? "yes" : "no"}
                    {facet.apiNotEnabled && " — a refresh reported it disabled"}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
