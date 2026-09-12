import type { ConnectedAccount, DavDiscoverySummary, DavFacet } from "@mail/shared";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "../api/auth.js";
import { addCalDavFacet, createCalDavAccount } from "../api/connected-accounts.js";
import { FACET_LABEL } from "./provider-table.js";

/**
 * CalDAV/CardDAV's add-a-Facet form (#203): server/email address, username
 * and app password, then discovery, then the account exists — the only
 * three fields this ever asks for, and the same three regardless of which
 * Facet cell opened it (Calendar and Contacts share one form; the `facet`
 * prop is which Facet discovery runs for). Nothing is saved unless
 * discovery succeeds (verify-before-save, the same rule
 * `AddMailAccountForm` already follows), and the flow only ever *reports*
 * what discovery found — choosing what to mirror is out of scope (#198,
 * ADR-0031, the Calendar/Contacts epics).
 *
 * When this User already has a CalDAV/CardDAV account missing this Facet,
 * the door opens on a chooser instead: attaching turns on the Facet by
 * discovery alone, "never asks for the password again" (#203's own
 * acceptance criterion) because the stored credential is what the attach
 * route re-runs discovery against, not anything typed here.
 *
 * #299: this is Calendar/Contacts' own multi-step form, so it now renders
 * inside a Dialog (`AddFacetControl.tsx`'s own `AddCalendarContactsFacetPopover`)
 * rather than swapping in place inside the Provider-choice Popover. Its own
 * heading stays plain markup rather than `Dialog`'s header primitives —
 * this form is also exercised standalone (`AddCalDavFacetForm.test.tsx`),
 * with no surrounding `Dialog` to supply the context those primitives need.
 */
export function AddCalDavFacetForm({
  facet,
  connectedAccounts,
  onAdded,
}: {
  facet: DavFacet;
  /** Every Connected Account this User has (`ConnectedAccountsPage`'s own `useConnectedAccounts()`) — filtered here to the CalDAV/CardDAV ones still missing this Facet. */
  connectedAccounts: ConnectedAccount[];
  onAdded: () => void;
}) {
  const eligible = connectedAccounts.filter(
    (account) =>
      account.provider === "caldav_carddav" && !account.facets.some((f) => f.kind === facet),
  );

  const [mode, setMode] = useState<"choose" | "entry">(eligible.length > 0 ? "choose" : "entry");
  const [serverAddress, setServerAddress] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discovered, setDiscovered] = useState<DavDiscoverySummary | null>(null);

  async function handleAttach(accountId: string) {
    setError(null);
    setSubmitting(true);
    try {
      const response = await addCalDavFacet(accountId, { facet });
      setDiscovered(response.discovered);
    } catch (err) {
      setError(describeFailure(facet, err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await createCalDavAccount({ serverAddress, username, password, facet });
      setDiscovered(response.discovered);
    } catch (err) {
      setError(describeFailure(facet, err));
    } finally {
      setSubmitting(false);
    }
  }

  if (discovered) {
    return (
      <>
        <h3 className="text-sm font-medium text-foreground">Connected</h3>
        <p role="status" className="text-sm text-muted-foreground">
          {describeFound(facet, discovered)}
        </p>
        <Button type="button" onClick={onAdded}>
          Done
        </Button>
      </>
    );
  }

  if (mode === "choose") {
    return (
      <>
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium text-foreground">
            Add {FACET_LABEL[facet].toLowerCase()}
          </h3>
          <p className="text-sm text-muted-foreground">CalDAV/CardDAV</p>
        </div>
        <div className="flex flex-col gap-2">
          {eligible.map((account) => (
            <Button
              key={account.id}
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => void handleAttach(account.id)}
            >
              Use {account.identity}
            </Button>
          ))}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => setMode("entry")}
            disabled={submitting}
          >
            Add a different CalDAV/CardDAV account
          </Button>
        </div>
      </>
    );
  }

  return (
    <form onSubmit={handleCreate} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-foreground">
          Add {FACET_LABEL[facet].toLowerCase()}
        </h3>
        <p className="text-sm text-muted-foreground">CalDAV/CardDAV</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`caldav-server-${facet}`}>Server or email address</Label>
        <Input
          id={`caldav-server-${facet}`}
          value={serverAddress}
          onChange={(event) => setServerAddress(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`caldav-username-${facet}`}>Username</Label>
        <Input
          id={`caldav-username-${facet}`}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`caldav-password-${facet}`}>App password</Label>
        <Input
          id={`caldav-password-${facet}`}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        {eligible.length > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setMode("choose")}
            disabled={submitting}
          >
            Back
          </Button>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? "Checking…" : "Discover and add"}
        </Button>
      </div>
    </form>
  );
}

/**
 * The three real failures #203's acceptance criteria distinguishes: the
 * host never answered, the credential was rejected (naming app passwords —
 * the acceptance criterion's own wording, since a provider's regular
 * password is the single most common wrong guess here), and a real server
 * answered with nothing for this Facet. `duplicate_identity` only ever
 * comes from the fresh-entry form re-adding a username already connected —
 * pointed back at the chooser this form itself offers.
 */
function describeFailure(facet: DavFacet, err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "unreachable":
        return "Couldn't reach that server.";
      case "credentials_rejected":
        return "That username or app password was rejected — some providers need a separate app-specific password rather than your regular one.";
      case "no_home_set":
        return facet === "calendar"
          ? "That server answered, but has no calendars for this account."
          : "That server answered, but has no address book for this account.";
      case "duplicate_identity":
        return "This username is already connected — pick it from the list instead of entering it again.";
    }
  }
  return `Couldn't add ${FACET_LABEL[facet].toLowerCase()}.`;
}

function describeFound(facet: DavFacet, discovered: DavDiscoverySummary): string {
  if (discovered.count === 0) {
    return facet === "calendar" ? "No calendars found yet." : "No address books found yet.";
  }
  const noun =
    facet === "calendar"
      ? discovered.count === 1
        ? "calendar"
        : "calendars"
      : discovered.count === 1
        ? "address book"
        : "address books";
  return `Found ${discovered.count} ${noun}: ${discovered.names.join(", ")}.`;
}
