import type { ProviderHealth } from "@mail/shared";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchInstanceInfo } from "../api/instance.js";
import { AddFacetControl } from "../connected-accounts/AddFacetControl.js";
import {
  type AccountFocus,
  clearAccountFocus,
  readAccountFocus,
} from "../connected-accounts/account-focus.js";
import { ConnectedAccountsTable } from "../connected-accounts/ConnectedAccountsTable.js";
import { SignatureEditor } from "../mail-accounts/SignatureEditor.js";
import { clearSignInOutcome, readSignInOutcome } from "../mail-accounts/sign-in-outcome.js";
import { rootRoute } from "../router/routes.js";
import { useConnectedAccounts, useMailAccounts } from "../store/index.js";

/** A later sign-in's own outcome replaces an earlier one still showing, rather than stacking. */
const SIGN_IN_OUTCOME_TOAST_ID = "sign-in-outcome-toast";

/**
 * Settings' Connected Accounts page (#201, replacing `MailAccountsPage` in
 * the same nav slot): one Card holding one Provider × Facet Table
 * (`ConnectedAccountsTable`, #172 Variant C, locked in), the Facet-phrased
 * add entry point below it, and — unchanged — each Mail Account's own
 * signature editor. The notifications toggle that used to sit beside it
 * moved to `NotificationsPage.tsx` (#244's own acceptance line: "the
 * per-Mail-Account `notificationsEnabled` toggle moves here") — "Mail
 * Accounts first" on the one page that now lists every notification
 * toggle, this Account's included.
 *
 * Deliberately **not** nested under `.settings-page` (#201's own acceptance
 * criterion): that legacy unlayered stylesheet's bare-element selectors
 * would outrank the shadcn kit's own utility classes regardless of
 * specificity (`settings.css`'s own history — the exact trap #172 round 3's
 * postmortem names). Only the still-bare-markup "Account preferences"
 * section below opts back into it, the same styling it always had.
 *
 * Reads both collections straight from the Local Cache
 * (`useConnectedAccounts`/`useMailAccounts`, ADR-0010) rather than
 * `MailAccountsSection`'s old direct `fetchMailAccounts()` call — that
 * component (and its DOM-anchor `scrollToMailAccountSettings`) is retired
 * by this ticket, replaced by `?account=` (`connected-accounts/account-focus.ts`)
 * since a table cell can hold several accounts' Badges, so there's no
 * longer one row per account to scroll to by id alone.
 */
export function ConnectedAccountsPage() {
  const mailAccounts = useMailAccounts() ?? [];
  const connectedAccounts = useConnectedAccounts() ?? [];
  // Only to choose the wording for an unregistered Provider (#116,
  // ADR-0021): the Owner is told where to fix it, a Member whom to ask.
  const { user } = rootRoute.useRouteContext();
  const isOwner = user.role === "owner";

  const [focus, setFocus] = useState<AccountFocus | null>(null);
  // Provider Health (#205, ADR-0022): Owner-only, so never fetched for a
  // Member — `GET /instance/health` itself 403s them anyway
  // (`routes/instance.ts`), but there's no reason to even try. `null` while
  // loading or on a Member; `ConnectedAccountsTable` renders no dot either way.
  const [providerHealth, setProviderHealth] = useState<Map<string, ProviderHealth> | null>(null);

  // The two query-string arrivals this page has to read once and then
  // scrub (#116's `?oauth=`, #201/#204's own `?account=&facet=`) — both
  // plain `window.location`/`history`, per each helper's own doc comment.
  // The outcome (#285) renders through the same Sonner surface every other
  // toast in the Client does (`components/ui/sonner.tsx`, mounted once in
  // `RootLayout`), rather than the page's own dismissible paragraph — a
  // toast is visible the instant the redirect lands, whichever Settings
  // section a User was last on, and clears itself instead of waiting to be
  // dismissed by hand. `succeeded` (`sign-in-outcome.ts`) picks the variant:
  // the Toaster's own `icons` map (`sonner.tsx`) already has a distinct
  // glyph for each.
  useEffect(() => {
    const outcome = readSignInOutcome(window.location.search);
    if (outcome) {
      const raise = outcome.succeeded ? toast.success : toast.error;
      raise(outcome.message, { id: SIGN_IN_OUTCOME_TOAST_ID });
      clearSignInOutcome();
    }
    const accountFocus = readAccountFocus(window.location.search);
    if (accountFocus) {
      setFocus(accountFocus);
      clearAccountFocus();
    }
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    void fetchInstanceInfo()
      .then((info) => {
        if (cancelled) return;
        setProviderHealth(new Map(info.providers.map((health) => [health.provider, health])));
      })
      .catch(() => {
        // Provider Health is a nice-to-have dot, not a page-blocking fact —
        // leaving it `null` just means no dot renders this load.
      });
    return () => {
      cancelled = true;
    };
  }, [isOwner]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <Card>
        <CardHeader>
          {/* `CardTitle` renders a plain `div` (`components/ui/card.tsx`'s own
              choice, matching upstream shadcn) so a page that wants an actual
              heading — this one, the page's own — supplies it: `contents`
              keeps `CardTitle`'s own type styling with no extra box. */}
          <CardTitle>
            <h2 className="contents">Connected Accounts</h2>
          </CardTitle>
          <CardDescription>Every Mail, Calendar and Contacts account, by Provider.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ConnectedAccountsTable
            connectedAccounts={connectedAccounts}
            mailAccounts={mailAccounts}
            isOwner={isOwner}
            focusConnectedAccountId={focus?.connectedAccountId ?? null}
            focusFacet={focus?.facet ?? null}
            providerHealth={providerHealth}
          />
          <div className="flex flex-wrap gap-2">
            <AddFacetControl
              facet="mail"
              variant="button"
              label="Add a mail account"
              isOwner={isOwner}
            />
            <AddFacetControl
              facet="calendar"
              variant="button"
              label="Add a calendar"
              isOwner={isOwner}
              connectedAccounts={connectedAccounts}
            />
            <AddFacetControl
              facet="contacts"
              variant="button"
              label="Add contacts"
              isOwner={isOwner}
              connectedAccounts={connectedAccounts}
            />
          </div>
        </CardContent>
      </Card>

      {mailAccounts.length > 0 && (
        <section className="settings-page">
          <section>
            <h3>Account preferences</h3>
            {mailAccounts.map((account) => (
              <div key={account.id} className="account-preferences">
                <strong>{account.emailAddress}</strong>
                <SignatureEditor account={account} />
              </div>
            ))}
          </section>
        </section>
      )}
    </div>
  );
}
