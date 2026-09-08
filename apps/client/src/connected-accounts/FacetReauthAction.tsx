import type { GrantableFacetKind, RegisteredProvider } from "@mail/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { startFacetGrant } from "../api/oauth-signin.js";

/**
 * A parked Calendar or Contacts Facet's own Fix (#204): the same
 * incremental-consent round `AddFacetControl.tsx#CalendarContactsFacetContent`
 * starts for a fresh Facet, reused verbatim — `POST /auth/oauth/:provider/start`
 * now lets a `needs_reauth` Facet through the same `add_facet` door
 * (`routes/oauth-signin.ts`'s own guard), and the callback's
 * `attachFacetToConnectedAccount` upserts the existing row back to `active`
 * rather than inserting a second one. Never Mail's own door
 * (`mail-accounts/ProviderReauthAction.tsx`) — Mail has no
 * `connectedAccountId`+`facet` pair to grant against, it reauthenticates the
 * whole Grant by `mailAccountId` instead.
 */
export function FacetReauthAction({
  connectedAccountId,
  provider,
  facet,
  label,
  navigate = (url) => window.location.assign(url),
}: {
  connectedAccountId: string;
  provider: RegisteredProvider;
  facet: GrantableFacetKind;
  label: string;
  navigate?: (url: string) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setStarting(true);
    try {
      const { authorizationUrl } = await startFacetGrant(provider, connectedAccountId, facet);
      // A full-page navigation, not a popup — same reasoning
      // `AddFacetControl`'s own `handlePick` gives (SameSite Lax).
      navigate(authorizationUrl);
    } catch {
      setError("Couldn't start reconnecting.");
      setStarting(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={starting}
        onClick={() => void handleClick()}
      >
        {label}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
