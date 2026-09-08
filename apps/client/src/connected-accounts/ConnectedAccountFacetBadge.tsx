import type { ConnectedAccount, ConnectedAccountFacetKind, MailAccount } from "@mail/shared";
import { useEffect, useRef, useState } from "react";
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
import { ProviderReauthAction } from "../mail-accounts/ProviderReauthAction.js";
import { ReauthMailAccountForm } from "../mail-accounts/ReauthMailAccountForm.js";
import { FACET_LABEL, PROVIDER_TABLE_LABEL } from "./provider-table.js";
import { RemoveFacetDialog } from "./RemoveFacetDialog.js";

/**
 * One Connected Account's status-dot Badge in one Facet's cell (#201, #172
 * Variant C round 3): outline when that Facet is `active`, destructive with
 * a Needs Reauth Popover when it isn't. Only the Mail Facet has a working
 * Fix today (`mailAccount` is null for Calendar/Contacts, since neither has
 * an add or reauth flow yet — the slices after this one) — its Fix is
 * exactly `mail-accounts/MailAccountsSection.tsx`'s own branch, moved here
 * rather than duplicated: never a password form for an OAuth account
 * (#119), and a password Mail Account gets the switch-to-Google-sign-in
 * door regardless of status.
 */
export function ConnectedAccountFacetBadge({
  account,
  facet,
  mailAccount,
  isOwner,
  autoFocus = false,
}: {
  account: ConnectedAccount;
  facet: ConnectedAccountFacetKind;
  /** The Mail Account this Facet projects onto — only ever set when `facet === "mail"`. */
  mailAccount: MailAccount | null;
  isOwner: boolean;
  /** The notification/cold-start deep link's target (#53, ADR-0015): open and scroll to this Badge as soon as it renders. */
  autoFocus?: boolean;
}) {
  const facetStatus = account.facets.find((candidate) => candidate.kind === facet)?.status;
  const needsReauth = facetStatus === "needs_reauth";
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popoverOpen, setPopoverOpen] = useState(autoFocus);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const accountRemoved = account.facets.length === 1;

  useEffect(() => {
    if (autoFocus) triggerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [autoFocus]);

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Badge
            ref={triggerRef}
            variant={needsReauth ? "destructive" : "outline"}
            className="cursor-pointer gap-1.5"
          >
            <span
              className={`size-1.5 rounded-full ${needsReauth ? "bg-destructive" : "bg-[var(--color-success)]"}`}
              aria-hidden
            />
            {account.identity}
          </Badge>
        </PopoverTrigger>
        <PopoverContent>
          <PopoverHeader>
            <PopoverTitle>{account.identity}</PopoverTitle>
            <PopoverDescription>
              {PROVIDER_TABLE_LABEL[account.provider]} · {FACET_LABEL[facet]}
            </PopoverDescription>
          </PopoverHeader>

          {needsReauth ? (
            <p role="status" className="text-sm text-destructive">
              Needs Reauth — the server rejected the stored credential.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Connected.</p>
          )}

          {mailAccount &&
            (needsReauth ? (
              mailAccount.authKind.kind === "oauth" ? (
                <ProviderReauthAction
                  mailAccountId={mailAccount.id}
                  provider={mailAccount.authKind.provider}
                  label={`Sign in with ${PROVIDER_TABLE_LABEL[mailAccount.authKind.provider]} again`}
                  isOwner={isOwner}
                />
              ) : (
                <ReauthMailAccountForm mailAccountId={mailAccount.id} onResumed={() => {}} />
              )
            ) : (
              mailAccount.authKind.kind === "password" && (
                <ProviderReauthAction
                  mailAccountId={mailAccount.id}
                  provider="google"
                  label="Switch to Google sign-in"
                  isOwner={isOwner}
                />
              )
            ))}

          {/* Turning off a Facet, removing a Connected Account (#206,
              ADR-0029) — a confirmed act, so this only opens the dialog; the
              Popover closes with it rather than staying open behind it. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-start text-destructive hover:text-destructive"
            onClick={() => {
              setPopoverOpen(false);
              setRemoveDialogOpen(true);
            }}
          >
            {accountRemoved ? "Remove account" : `Turn off ${FACET_LABEL[facet].toLowerCase()}`}
          </Button>
        </PopoverContent>
      </Popover>

      <RemoveFacetDialog
        account={account}
        facet={facet}
        open={removeDialogOpen}
        onOpenChange={setRemoveDialogOpen}
      />
    </>
  );
}
