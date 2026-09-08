import type { ProviderHealth } from "@mail/shared";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchInstanceInfo } from "../api/instance.js";
import { AddFacetControl } from "../connected-accounts/AddFacetControl.js";
import { clearAccountFocus, readAccountFocus } from "../connected-accounts/account-focus.js";
import { ConnectedAccountsTable } from "../connected-accounts/ConnectedAccountsTable.js";
import { SignatureEditor } from "../mail-accounts/SignatureEditor.js";
import {
  clearSignInOutcome,
  readSignInOutcome,
  type SignInOutcome,
} from "../mail-accounts/sign-in-outcome.js";
import { rootRoute } from "../router/routes.js";
import { enqueueMutation, useConnectedAccounts, useMailAccounts } from "../store/index.js";

/**
 * Settings' Connected Accounts page (#201, replacing `MailAccountsPage` in
 * the same nav slot): one Card holding one Provider × Facet Table
 * (`ConnectedAccountsTable`, #172 Variant C, locked in), the Facet-phrased
 * add entry point below it, and — unchanged — each Mail Account's own
 * signature and notifications toggle.
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

  const [signInOutcome, setSignInOutcome] = useState<SignInOutcome | null>(null);
  const [focusMailAccountId, setFocusMailAccountId] = useState<string | null>(null);
  // Provider Health (#205, ADR-0022): Owner-only, so never fetched for a
  // Member — `GET /instance/health` itself 403s them anyway
  // (`routes/instance.ts`), but there's no reason to even try. `null` while
  // loading or on a Member; `ConnectedAccountsTable` renders no dot either way.
  const [providerHealth, setProviderHealth] = useState<Map<string, ProviderHealth> | null>(null);

  // The two query-string arrivals this page has to read once and then
  // scrub (#116's `?oauth=`, #201's own `?account=`) — both plain
  // `window.location`/`history`, per each helper's own doc comment.
  useEffect(() => {
    const outcome = readSignInOutcome(window.location.search);
    if (outcome) {
      setSignInOutcome(outcome);
      clearSignInOutcome();
    }
    const focus = readAccountFocus(window.location.search);
    if (focus) {
      setFocusMailAccountId(focus);
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
      {signInOutcome && (
        <p role="status" className="text-sm text-muted-foreground">
          {signInOutcome.message}{" "}
          <button type="button" onClick={() => setSignInOutcome(null)}>
            Dismiss
          </button>
        </p>
      )}

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
            focusMailAccountId={focusMailAccountId}
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
                <label>
                  <input
                    type="checkbox"
                    checked={account.notificationsEnabled}
                    onChange={(event) =>
                      void enqueueMutation(
                        { type: "setNotificationsEnabled", enabled: event.target.checked },
                        account.id,
                      )
                    }
                  />
                  Notifications
                </label>
              </div>
            ))}
          </section>
        </section>
      )}
    </div>
  );
}
