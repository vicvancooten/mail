import type { ConnectedAccount, MailAccount, ProviderHealth } from "@mail/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AddFacetControl } from "./AddFacetControl.js";
import { ConnectedAccountFacetBadge } from "./ConnectedAccountFacetBadge.js";
import { ProviderHealthDot } from "./ProviderHealthDot.js";
import {
  FACET_COLUMNS,
  FACET_LABEL,
  facetSupportedByProvider,
  PROVIDER_TABLE_LABEL,
  PROVIDER_TABLE_ROWS,
} from "./provider-table.js";

/**
 * The Connected Accounts table (#201, #172 Variant C, locked in): one Card
 * holding one Table, rows are Providers and columns are Facets. Each
 * possible cell holds a status-dot Badge per Connected Account carrying
 * that Facet plus a dashed "+" to add one; an impossible cell (a Provider
 * that can never carry a Facet — `provider-table.ts#FACET_SUPPORTED_BY_PROVIDER`)
 * is an em dash instead. Renders only what already exists (#201's own
 * scope note): today's Mail Accounts, via `connectedAccountId`
 * (`@mail/shared#mailAccountSchema`'s own doc comment) — Calendar and
 * Contacts columns are real and always render their "+", but never a
 * Connected Account yet, since nothing can add one there today.
 *
 * `providerHealth` (#205) puts a small `ProviderHealthDot` beside a
 * Provider's own name — Owner-only, "present, not prominent" — for a Google
 * or Microsoft row that has an entry; a Member (`isOwner: false`) or a
 * CalDAV/CardDAV/Other IMAP row never gets one.
 */
export function ConnectedAccountsTable({
  connectedAccounts,
  mailAccounts,
  isOwner,
  focusMailAccountId,
  providerHealth = null,
}: {
  connectedAccounts: ConnectedAccount[];
  mailAccounts: MailAccount[];
  isOwner: boolean;
  /** The notification/cold-start deep link's target Mail Account, if any (#53, ADR-0015). */
  focusMailAccountId: string | null;
  /**
   * Provider Health (#205, ADR-0022), Owner-only — `null` (the default) for
   * a Member, who gets no health dot at all, or while an Owner's own fetch
   * is still in flight. Keyed by Provider; only Google and Microsoft ever
   * have an entry (`RegisteredProvider`), so CalDAV/CardDAV and Other IMAP
   * rows never render a dot regardless of this map's contents.
   */
  providerHealth?: Map<string, ProviderHealth> | null;
}) {
  const mailAccountByConnectedAccountId = new Map(
    mailAccounts.map((account) => [account.connectedAccountId, account]),
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Provider</TableHead>
          {FACET_COLUMNS.map((facet) => (
            <TableHead key={facet}>{FACET_LABEL[facet]}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {PROVIDER_TABLE_ROWS.map((provider) => {
          const health = isOwner ? (providerHealth?.get(provider) ?? null) : null;
          return (
            <TableRow key={provider}>
              <TableHead scope="row" className="font-medium text-foreground">
                <span className="inline-flex items-center gap-1.5">
                  {PROVIDER_TABLE_LABEL[provider]}
                  {health && <ProviderHealthDot health={health} />}
                </span>
              </TableHead>
              {FACET_COLUMNS.map((facet) => {
                if (!facetSupportedByProvider(provider, facet)) {
                  return (
                    <TableCell key={facet} className="text-center text-muted-foreground">
                      —
                    </TableCell>
                  );
                }

                const accountsInCell = connectedAccounts.filter(
                  (account) =>
                    account.provider === provider &&
                    account.facets.some((candidate) => candidate.kind === facet),
                );

                return (
                  <TableCell key={facet}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {accountsInCell.map((account) => (
                        <ConnectedAccountFacetBadge
                          key={account.id}
                          account={account}
                          facet={facet}
                          mailAccount={mailAccountByConnectedAccountId.get(account.id) ?? null}
                          isOwner={isOwner}
                          autoFocus={
                            facet === "mail" &&
                            mailAccountByConnectedAccountId.get(account.id)?.id ===
                              focusMailAccountId
                          }
                        />
                      ))}
                      <AddFacetControl
                        facet={facet}
                        isOwner={isOwner}
                        connectedAccounts={connectedAccounts}
                      />
                    </div>
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
